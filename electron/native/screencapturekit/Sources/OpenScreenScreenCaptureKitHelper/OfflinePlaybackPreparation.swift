import AVFoundation
import CoreMedia
import Darwin
import Foundation

/// Offline-only: no ScreenCaptureKit, device enumeration, or privacy API calls.
enum OfflinePlaybackPreparation {
	struct Failure: Error, CustomStringConvertible {
		let description: String
		init(_ message: String) { description = message }
	}

	struct Validation {
		let audioTrackCount: Int
		let audioSampleCount: Int
		let videoSampleCount: Int
	}

	static func validate(source: URL, output: URL) async throws -> Validation {
		let original = AVURLAsset(url: source)
		let asset = AVURLAsset(url: output)
		let originalAudio = try await original.loadTracks(withMediaType: .audio)
		let videos = try await asset.loadTracks(withMediaType: .video)
		let audios = try await asset.loadTracks(withMediaType: .audio)
		guard videos.count == 1, audios.count == (originalAudio.isEmpty ? 0 : 1) else {
			throw Failure("Playback validation requires one video and exactly one mixed audio track when source audio exists.")
		}
		let sourceVideos = try await original.loadTracks(withMediaType: .video)
		guard let sourceVideo = sourceVideos.first else { throw Failure("Original recording contains no video.") }
		let sourceRange = try await sourceVideo.load(.timeRange)
		let outputRange = try await videos[0].load(.timeRange)
		guard abs(sourceRange.start.seconds - outputRange.start.seconds) < 0.12,
			abs(sourceRange.duration.seconds - outputRange.duration.seconds) < 0.12 else {
			throw Failure("Playback validation found a changed video clock or duration.")
		}
		let reader = try AVAssetReader(asset: asset)
		let video = AVAssetReaderTrackOutput(track: videos[0], outputSettings: nil)
		video.alwaysCopiesSampleData = false
		guard reader.canAdd(video) else { throw Failure("Cannot validate playback video.") }
		reader.add(video)
		let audio = audios.first.map { AVAssetReaderTrackOutput(track: $0, outputSettings: nil) }
		if let audio = audio {
			audio.alwaysCopiesSampleData = false
			guard reader.canAdd(audio) else { throw Failure("Cannot validate playback audio.") }
			reader.add(audio)
		}
		guard reader.startReading() else { throw Failure("Cannot read prepared playback: \(reader.error?.localizedDescription ?? "unknown error")") }
		var videoSamples = 0
		while let sample = video.copyNextSampleBuffer() { videoSamples += CMSampleBufferGetNumSamples(sample) }
		var audioSamples = 0
		while let sample = audio?.copyNextSampleBuffer() { audioSamples += CMSampleBufferGetNumSamples(sample) }
		guard reader.status == .completed, videoSamples > 0, (audio == nil || audioSamples > 0) else {
			throw Failure("Playback validation found missing media samples: \(reader.error?.localizedDescription ?? "empty audio/video output")")
		}
		return Validation(audioTrackCount: audios.count, audioSampleCount: audioSamples, videoSampleCount: videoSamples)
	}

	static func prepare(source: URL, output: URL) async throws -> Validation {
		guard source.standardizedFileURL != output.standardizedFileURL else { throw Failure("Playback output must not replace the original recording.") }
		guard !FileManager.default.fileExists(atPath: output.path) else { throw Failure("Playback output already exists; refusing to overwrite \(output.path).") }
		let temporary = output.deletingLastPathComponent().appendingPathComponent(".\(output.lastPathComponent).\(UUID().uuidString).tmp.mp4")
		defer { try? FileManager.default.removeItem(at: temporary) }
		let asset = AVURLAsset(url: source)
		let videos = try await asset.loadTracks(withMediaType: .video)
		guard videos.count == 1, let videoTrack = videos.first else { throw Failure("Original recording must contain exactly one video track.") }
		let audios = try await asset.loadTracks(withMediaType: .audio)
		let reader = try AVAssetReader(asset: asset)
		let writer = try AVAssetWriter(outputURL: temporary, fileType: .mp4)
		writer.shouldOptimizeForNetworkUse = true
		writer.metadata = try await asset.load(.metadata)
		let videoRange = try await videoTrack.load(.timeRange)
		guard videoRange.duration.isNumeric, videoRange.duration.seconds > 0 else { throw Failure("Original recording has no video duration.") }
		let videoEnd = CMTimeRangeGetEnd(videoRange)
		// Reader mixes original asset tracks directly, preserving their individual start
		// timestamps (including late microphone capture). No zero-based reinsertion.
		reader.timeRange = CMTimeRange(start: .zero, duration: videoEnd)
		let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: nil)
		videoOutput.alwaysCopiesSampleData = false
		let formats = try await videoTrack.load(.formatDescriptions)
		let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: formats.first)
		videoInput.expectsMediaDataInRealTime = false
		videoInput.transform = try await videoTrack.load(.preferredTransform)
		guard reader.canAdd(videoOutput), writer.canAdd(videoInput) else { throw Failure("Video codec cannot be passed through into MP4 without changing the recording.") }
		reader.add(videoOutput)
		writer.add(videoInput)
		var channels: [(AVAssetReaderOutput, AVAssetWriterInput)] = [(videoOutput, videoInput)]
		if !audios.isEmpty {
			let audioOutput = AVAssetReaderAudioMixOutput(audioTracks: audios, audioSettings: [
				AVFormatIDKey: kAudioFormatLinearPCM,
				AVSampleRateKey: 48_000,
				AVNumberOfChannelsKey: 2,
				AVLinearPCMBitDepthKey: 32,
				AVLinearPCMIsFloatKey: true,
				AVLinearPCMIsNonInterleaved: false,
			])
			audioOutput.alwaysCopiesSampleData = false
			let mix = AVMutableAudioMix()
			mix.inputParameters = audios.map { track in
				let parameters = AVMutableAudioMixInputParameters(track: track)
				parameters.setVolume(1, at: .zero)
				return parameters
			}
			audioOutput.audioMix = mix
			let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
				AVFormatIDKey: kAudioFormatMPEG4AAC,
				AVSampleRateKey: 48_000,
				AVNumberOfChannelsKey: 2,
				AVEncoderBitRateKey: 192_000,
			])
			audioInput.expectsMediaDataInRealTime = false
			guard reader.canAdd(audioOutput), writer.canAdd(audioInput) else { throw Failure("Cannot configure native audio mix.") }
			reader.add(audioOutput)
			writer.add(audioInput)
			channels.append((audioOutput, audioInput))
		}
		guard writer.startWriting(), reader.startReading() else { throw Failure("Cannot start native playback preparation: \(writer.error?.localizedDescription ?? reader.error?.localizedDescription ?? "unknown error")") }
		writer.startSession(atSourceTime: .zero)
		await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
			let group = DispatchGroup()
			for (index, channel) in channels.enumerated() {
				group.enter()
				let (output, input) = channel
				let queue = DispatchQueue(label: "app.openscreen.offline-playback.\(index)")
				var finished = false
				let monitor = DispatchSource.makeTimerSource(queue: queue)
				let finish = {
					guard !finished else { return }
					finished = true
					monitor.cancel()
					if writer.status == .writing { input.markAsFinished() }
					group.leave()
				}
				// Failure can make an input permanently not-ready, so do not rely on
				// another readiness callback to release its channel after an I/O error.
				monitor.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
				monitor.setEventHandler {
					if writer.status != .writing || reader.status == .failed || reader.status == .cancelled { finish() }
				}
				monitor.resume()
				input.requestMediaDataWhenReady(on: queue) {
					guard !finished else { return }
					while input.isReadyForMoreMediaData {
						guard let sample = output.copyNextSampleBuffer() else {
							finish()
							return
						}
						if !input.append(sample) {
							reader.cancelReading()
							finish()
							return
						}
					}
				}
			}
			group.notify(queue: DispatchQueue.global(qos: .userInitiated)) { continuation.resume() }
		}
		guard reader.status == .completed, writer.status == .writing else {
			writer.cancelWriting()
			throw Failure("Native playback mixing failed: \(reader.error?.localizedDescription ?? writer.error?.localizedDescription ?? "media reader did not complete")")
		}
		writer.endSession(atSourceTime: videoEnd)
		await writer.finishWriting()
		guard writer.status == .completed else { throw Failure("Native playback writer failed: \(writer.error?.localizedDescription ?? "unknown error")") }
		let result = try await validate(source: source, output: temporary)
		// POSIX hard-link publication is atomic and exclusive on this same filesystem.
		// A racing creator wins safely; neither it nor the original can be overwritten.
		guard link(temporary.path, output.path) == 0 else { throw Failure("Could not publish playback exclusively: \(String(cString: strerror(errno))).") }
		return result
	}
}
