import { describe, expect, test } from "bun:test";
import {
  controlAcknowledgementError,
  controlAcknowledgementMessage,
  logControlAcknowledgement,
} from "../src/ui/lib/control-ack.ts";

describe("browser control acknowledgements", () => {
  test("formats negative control acknowledgements for the browser console", () => {
    expect(
      controlAcknowledgementMessage(
        '{"ok":false,"error":"  gesture rejected  "}',
      ),
    ).toBe("gesture rejected");
    expect(
      controlAcknowledgementError(
        JSON.stringify({
          ok: false,
          code: "control-input-rejected",
          error: "grpc-screenshot text input supports ASCII only",
        }),
      ),
    ).toBe(
      "serve-emu control input rejected: grpc-screenshot text input supports ASCII only",
    );
  });

  test("ignores success responses and non-acknowledgement socket messages", () => {
    expect(controlAcknowledgementError('{"ok":true}')).toBeNull();
    expect(
      controlAcknowledgementError(
        '{"type":"video-session","size":{"width":720,"height":1280}}',
      ),
    ).toBeNull();
    expect(controlAcknowledgementError('{"ok":false,"error":"   "}')).toBeNull();
    expect(controlAcknowledgementError("not json")).toBeNull();
  });

  test("gives video-session messages precedence over acknowledgement fields", () => {
    expect(
      controlAcknowledgementError(
        JSON.stringify({
          type: "video-session",
          size: { width: 720, height: 1280 },
          ok: false,
          error: "not a control rejection",
        }),
      ),
    ).toBeNull();
  });

  test("logs negative acknowledgements through the error console path", () => {
    const errors: string[] = [];
    const logged = logControlAcknowledgement(
      '{"ok":false,"error":"grpc-screenshot supports ASCII text only"}',
      (message) => errors.push(message),
    );

    expect(logged).toBe(true);
    expect(errors).toEqual([
      "serve-emu control input rejected: grpc-screenshot supports ASCII text only",
    ]);
    expect(logControlAcknowledgement('{"ok":true}', (message) => errors.push(message))).toBe(false);
    expect(errors).toHaveLength(1);
  });
});
