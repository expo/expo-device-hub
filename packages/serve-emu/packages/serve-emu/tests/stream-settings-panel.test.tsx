import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StreamSettingsPanel,
  applyStreamQualitySettings,
  mergeStreamQualityDraft,
  streamQualityDraft,
  streamQualityDirtyFields,
  streamQualityPatchFromDraft,
  streamQualityStatus,
} from "../src/ui/components/stream-settings-panel";
import { createDeviceSessionStore } from "../src/ui/lib/device-session-store";

const CURRENT_SETTINGS = {
  maxDimension: 720,
  h264Bitrate: 8_000_000,
  h264Fps: 30,
};

describe("stream quality form values", () => {
  test("presents bitrate in Mbps and creates only the changed API fields", () => {
    expect(streamQualityDraft(CURRENT_SETTINGS)).toEqual({
      maxDimension: "720",
      h264BitrateMbps: "8",
      h264Fps: "30",
    });
    expect(
      streamQualityPatchFromDraft(
        {
          maxDimension: "1080",
          h264BitrateMbps: "8.5",
          h264Fps: "30",
        },
        CURRENT_SETTINGS,
      ),
    ).toEqual({
      ok: true,
      patch: { maxDimension: 1080, h264Bitrate: 8_500_000 },
    });
  });

  test("accepts native size and the documented encoder boundaries", () => {
    expect(
      streamQualityPatchFromDraft(
        {
          maxDimension: "0",
          h264BitrateMbps: "0.1",
          h264Fps: "120",
        },
        CURRENT_SETTINGS,
      ),
    ).toEqual({
      ok: true,
      patch: {
        maxDimension: 0,
        h264Bitrate: 100_000,
        h264Fps: 120,
      },
    });
  });

  test("refreshes untouched values without replacing an edited draft field", () => {
    expect(
      mergeStreamQualityDraft(
        {
          maxDimension: "900",
          h264BitrateMbps: "8",
          h264Fps: "30",
        },
        {
          maxDimension: "1080",
          h264BitrateMbps: "12",
          h264Fps: "60",
        },
        { maxDimension: true },
      ),
    ).toEqual({
      maxDimension: "900",
      h264BitrateMbps: "12",
      h264Fps: "60",
    });
    expect(
      streamQualityDirtyFields(
        {
          maxDimension: "1080",
          h264BitrateMbps: "12",
          h264Fps: "60",
        },
        {
          maxDimension: "1080",
          h264BitrateMbps: "12",
          h264Fps: "60",
        },
      ),
    ).toEqual({});
  });

  test("identifies the invalid field before making an API request", () => {
    expect(
      streamQualityPatchFromDraft(
        {
          maxDimension: "720.5",
          h264BitrateMbps: "8",
          h264Fps: "30",
        },
        CURRENT_SETTINGS,
      ),
    ).toMatchObject({ ok: false, field: "maxDimension" });
    expect(
      streamQualityPatchFromDraft(
        {
          maxDimension: "720",
          h264BitrateMbps: "50.1",
          h264Fps: "30",
        },
        CURRENT_SETTINGS,
      ),
    ).toMatchObject({ ok: false, field: "h264BitrateMbps" });
    expect(
      streamQualityPatchFromDraft(
        {
          maxDimension: "720",
          h264BitrateMbps: "8",
          h264Fps: "0",
        },
        CURRENT_SETTINGS,
      ),
    ).toMatchObject({ ok: false, field: "h264Fps" });
    expect(
      streamQualityPatchFromDraft(
        {
          maxDimension: "720",
          h264BitrateMbps: "0.1000001",
          h264Fps: "30",
        },
        CURRENT_SETTINGS,
      ),
    ).toEqual({
      ok: false,
      field: "h264BitrateMbps",
      message: "Bitrate supports at most six decimal places in Mbps.",
    });
  });

  test("captures the revision after synchronizing the replaced stream session", async () => {
    const store = createDeviceSessionStore();
    store.applyHealth({ serial: "emulator-5554", sessionGeneration: 1 });
    const calls: string[] = [];
    const streamMode = {
      ok: true as const,
      serial: "emulator-5554",
      mode: "scrcpy" as const,
      availableModes: ["scrcpy" as const, "grpc-screenshot" as const],
      sessionGeneration: 2,
    };

    const applied = await applyStreamQualitySettings(
      { h264Fps: 60 },
      "emulator-5554",
      {
        store,
        patchSettings: async () => {
          calls.push("patch");
          return { ok: true, ...CURRENT_SETTINGS, h264Fps: 60 };
        },
        readStreamMode: async () => {
          calls.push("mode");
          return streamMode;
        },
      },
    );

    expect(calls).toEqual(["patch", "mode"]);
    expect(store.getSnapshot().sessionGeneration).toBe(2);
    expect(applied.revision).toBe(store.getSnapshot().revision);
    const feedback = {
      revision: applied.revision,
      kind: "status" as const,
      message: "Applied",
    };
    expect(
      streamQualityStatus({
        busy: false,
        transitioning: false,
        selectionReady:
          feedback.revision === store.getSnapshot().revision,
        feedback,
      }),
    ).toBe("Applied");

    store.applyHealth(streamMode);
    expect(store.getSnapshot().revision).toBe(applied.revision);
    expect(
      streamQualityStatus({
        busy: false,
        transitioning: false,
        selectionReady:
          feedback.revision === store.getSnapshot().revision,
        feedback,
      }),
    ).toBe("Applied");
  });
});

describe("StreamSettingsPanel", () => {
  test("renders an accessible form disabled until current settings load", () => {
    const markup = renderToStaticMarkup(<StreamSettingsPanel />);

    expect(markup).toContain('aria-labelledby="stream-quality-heading"');
    expect(markup).toContain('<h3 id="stream-quality-heading">Quality</h3>');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('<legend class="visually-hidden">Stream quality</legend>');
    expect(markup.match(/type="number"/g)?.length).toBe(3);
    expect(markup).toContain('for="stream-max-dimension"');
    expect(markup).toContain('for="stream-bitrate"');
    expect(markup).toContain('for="stream-frame-rate"');
    expect(markup).toContain('list="stream-dimension-presets"');
    expect(markup).toContain('list="stream-bitrate-presets"');
    expect(markup).toContain('list="stream-fps-presets"');
    expect(markup).toContain('<button type="submit" disabled="">Apply quality</button>');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('class="stream-quality-input"');
    expect(markup).toContain(
      '<label for="stream-max-dimension"><span>Max dimension (px)</span><input',
    );
    expect(markup).toContain("Applying changes restarts the stream");
    expect(markup).toContain("reconnects automatically when needed");
  });
});
