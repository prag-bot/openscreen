import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchWindow } from "./LaunchWindow";

const recorder = vi.hoisted(() => ({
	recording: false,
	paused: false,
	webcamEnabled: true,
	webcamPreviewStream: null,
	microphoneEnabled: true,
	elapsedSeconds: 0,
}));

vi.mock("../../hooks/useScreenRecorder", () => ({ useScreenRecorder: () => recorder }));
vi.mock("../../hooks/useAudioLevelMeter", () => ({ useAudioLevelMeter: () => ({ level: 0 }) }));
vi.mock("../../hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({ devices: [], selectedDeviceId: "", isLoading: false }),
}));
vi.mock("../../hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => ({ devices: [], selectedDeviceId: "" }),
}));
vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return {
		useScopedT: () => translate,
		useI18n: () => ({ locale: "en", systemLocaleSuggestion: null }),
	};
});
vi.mock("@/lib/userPreferences", () => ({
	loadUserPreferences: () => ({ trayLayout: "vertical" }),
	saveUserPreferences: vi.fn(),
}));
vi.mock("@/native", () => ({
	nativeBridgeClient: { system: { getPlatform: () => Promise.resolve("linux") } },
}));
vi.mock("../ui/tooltip", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));

const resizeWindow = vi.fn();
const ignoreMouseEvents = vi.fn();
const observers = new Set<ResizeObserverCallback>();
const naturalBarHeight = 550;

function rectangle(width: number, height: number, bottom = height) {
	return { width, height, top: bottom - height, bottom, left: 0, right: width } as DOMRect;
}

// jsdom does not lay out CSS. Model the real window clamp, frame size and tray
// max-height explicitly, so these tests exercise the component's measurements.
function frameSize() {
	const frame = document.querySelector<HTMLElement>("[data-hud-webcam-frame]");
	return frame ? Number.parseFloat(frame.style.height) || 0 : 160;
}

function panelHeight() {
	return frameSize() + (recorder.recording ? 38 : 82);
}

function renderedBarHeight(el: HTMLElement) {
	const reserved = /100vh - ([\d.]+)px/.exec(el.style.maxHeight);
	return Math.min(
		naturalBarHeight + 2,
		reserved ? Math.max(0, window.innerHeight - Number(reserved[1])) : naturalBarHeight + 2,
	);
}

function notifyResize() {
	act(() => {
		for (const callback of observers) callback([], {} as ResizeObserver);
	});
}

function settleMeasurements() {
	// One notification for the resized panel, then one for the resized tray.
	notifyResize();
	notifyResize();
	notifyResize();
}

beforeEach(() => {
	recorder.recording = false;
	recorder.paused = false;
	resizeWindow.mockClear();
	ignoreMouseEvents.mockClear();
	vi.stubGlobal("innerHeight", 600);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private callback: ResizeObserverCallback) {
				observers.add(callback);
			}
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect() {
				observers.delete(this.callback);
			}
		},
	);
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			setHudOverlaySize: resizeWindow,
			setHudOverlayIgnoreMouseEvents: ignoreMouseEvents,
			getSelectedSource: vi.fn().mockResolvedValue(null),
		},
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
		if (this.hasAttribute("data-tray-layout")) {
			return rectangle(144, renderedBarHeight(this), window.innerHeight - 20);
		}
		if (this.hasAttribute("data-hud-webcam-frame")) return rectangle(frameSize(), frameSize());
		if (
			this.contains(document.querySelector("[data-testid='launch-webcam-preview']")) &&
			this.classList.contains("fixed")
		) {
			return rectangle(288, panelHeight());
		}
		return rectangle(0, 0);
	});
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
		return this.hasAttribute("data-tray-layout") ? naturalBarHeight : 0;
	});
	vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(144);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
		return this.hasAttribute("data-tray-layout") ? renderedBarHeight(this) : 0;
	});
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
		return this.hasAttribute("data-tray-layout") ? renderedBarHeight(this) - 2 : 0;
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	observers.clear();
});

describe("camera HUD layout and click-through", () => {
	it("captures visible controls but not the measurement wrapper or its gaps", () => {
		render(<LaunchWindow />);
		const preview = screen.getByTestId("launch-webcam-preview");
		const panel = preview.parentElement!;
		expect(panel.getAttribute("data-hud-interactive")).toBeNull();
		expect(panel.classList.contains("pointer-events-none")).toBe(true);
		expect(preview.getAttribute("data-hud-interactive")).toBeNull();

		const video = screen.getByLabelText("Live camera preview");
		const pill = screen.getByText("Camera preview").parentElement!;
		const selectors = panel.querySelectorAll("select");
		for (const control of [video, pill, ...selectors, screen.getByTestId("launch-record-button")]) {
			expect(control.closest("[data-hud-interactive='true']")).not.toBeNull();
			fireEvent.pointerMove(control);
			expect(ignoreMouseEvents).toHaveBeenLastCalledWith(false);
			fireEvent.pointerMove(panel);
			expect(ignoreMouseEvents).toHaveBeenLastCalledWith(true);
		}
		fireEvent.pointerMove(selectors[0].parentElement!.parentElement!.parentElement!);
		expect(ignoreMouseEvents).toHaveBeenLastCalledWith(true);
	});

	it("reserves the panel above a scrolling tray and keeps natural resize requests stable", () => {
		render(<LaunchWindow />);
		settleMeasurements();
		const panel = screen.getByTestId("launch-webcam-preview").parentElement!;
		const bar = document.querySelector<HTMLElement>("[data-tray-layout]")!;
		expect(bar.style.maxHeight).toContain("100vh - 294px");
		expect(bar.classList.contains("[&>*]:shrink-0")).toBe(true);
		expect(bar.getBoundingClientRect().height).toBe(306);
		expect(panel.style.bottom).toBe("334px");
		expect(window.innerHeight - Number.parseFloat(panel.style.bottom) - panelHeight()).toBe(24);
		expect(resizeWindow).toHaveBeenLastCalledWith(312, 846);

		resizeWindow.mockClear();
		vi.stubGlobal("innerHeight", 700);
		fireEvent(window, new Event("resize"));
		settleMeasurements();
		expect(panel.style.bottom).toBe("434px");
		expect(resizeWindow).not.toHaveBeenCalled();
	});

	it("updates the reservation during recording without losing paused preview controls", () => {
		const { rerender } = render(<LaunchWindow />);
		settleMeasurements();
		recorder.recording = true;
		rerender(<LaunchWindow />);
		settleMeasurements();
		const panel = screen.getByTestId("launch-webcam-preview").parentElement!;
		const bar = document.querySelector<HTMLElement>("[data-tray-layout]")!;
		expect(panel.querySelectorAll("select")).toHaveLength(0);
		expect(bar.style.maxHeight).toContain("100vh - 250px");
		expect(panel.style.bottom).toBe("378px");
		expect(resizeWindow).toHaveBeenLastCalledWith(312, 802);
		recorder.paused = true;
		rerender(<LaunchWindow />);
		settleMeasurements();
		expect(screen.getByText("Paused")).toBeTruthy();
		fireEvent.pointerMove(screen.getByRole("button", { name: "Unmirror preview" }));
		expect(ignoreMouseEvents).toHaveBeenLastCalledWith(false);
		expect(panel.style.bottom).toBe("378px");
	});

	it("shrinks the circle in truly short windows without shrinking the desired full-content window", () => {
		vi.stubGlobal("innerHeight", 320);
		render(<LaunchWindow />);
		settleMeasurements();
		const frame = screen.getByLabelText("Live camera preview").parentElement!;
		const panel = screen.getByTestId("launch-webcam-preview").parentElement!;
		const bar = document.querySelector<HTMLElement>("[data-tray-layout]")!;
		expect(frame.style.height).toBe("90px");
		expect(frame.style.width).toBe("90px");
		expect(bar.getBoundingClientRect().height).toBe(96);
		expect(panel.style.bottom).toBe("124px");
		expect(window.innerHeight - Number.parseFloat(panel.style.bottom) - panelHeight()).toBe(24);
		expect(resizeWindow).toHaveBeenLastCalledWith(312, 846);
		resizeWindow.mockClear();
		settleMeasurements();
		expect(resizeWindow).not.toHaveBeenCalled();
	});
});
