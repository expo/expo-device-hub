import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

type Reply = { stdout: string; stderr: string; exitCode: number };
const calls: { action: string; params: unknown; reply: (value: Reply) => void }[] = [];
mock.module("../../socket/client-control", () => ({
  runHostAction: (action: string, params: unknown) =>
    new Promise<Reply>((reply) => calls.push({ action, params, reply })),
}));
const { EgressGuardTool } = await import("../../client/components/egress-guard-tool");
let rendered: ReactTestRenderer | undefined;
const udid = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const toggle = () => rendered!.root.findByProps({ role: "switch" });
async function mount(device = udid) {
  await act(async () => {
    rendered = create(<EgressGuardTool key={device} udid={device} />);
  });
}
async function reply(index: number, value: unknown) {
  await act(async () =>
    calls[index]!.reply({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 }),
  );
}
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
  calls.length = 0;
});

test("toggle stays pending until the selected device acknowledges policy", async () => {
  await mount();
  expect(toggle().props.disabled).toBe(true);
  expect(calls[0]).toMatchObject({ action: "egress.status", params: { udid } });
  await reply(0, { available: true, enabled: false });
  await act(async () => toggle().props.onClick());
  expect(calls[1]).toMatchObject({ action: "egress.set", params: { udid, enabled: true } });
  expect(toggle().props.disabled).toBe(true);
  expect(toggle().props["aria-checked"]).toBe(false);
  await reply(1, { available: true, enabled: true });
  expect(calls[2]).toMatchObject({ action: "egress.status", params: { udid } });
  await reply(2, { available: true, enabled: true });
  expect(toggle().props["aria-checked"]).toBe(true);
  expect(toggle().props.disabled).toBe(false);
});

test("unenrolled and failed controls do not imply success or trigger enrollment", async () => {
  await mount();
  await reply(0, { available: false });
  expect(toggle().props.disabled).toBe(true);
  await act(async () => toggle().props.onClick());
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(rendered!.toJSON())).toContain("not available for this session");
});

test("old device acknowledgement cannot change the new device", async () => {
  await mount();
  await reply(0, { available: true, enabled: false });
  await act(async () => toggle().props.onClick());
  await act(async () => rendered!.update(<EgressGuardTool key={other} udid={other} />));
  expect(calls[2]).toMatchObject({ action: "egress.status", params: { udid: other } });
  await reply(1, { available: true, enabled: true });
  expect(toggle().props.disabled).toBe(true);
  await reply(2, { available: true, enabled: false });
  expect(toggle().props["aria-checked"]).toBe(false);
});

test("failed mutation reads blocking cleanup back and shows its error", async () => {
  await mount();
  await reply(0, { available: true, enabled: false });
  await act(async () => toggle().props.onClick());
  await act(async () =>
    calls[1]!.reply({ stdout: "", stderr: "Policy check failed", exitCode: 1 }),
  );
  expect(calls[2]).toMatchObject({ action: "egress.status", params: { udid } });
  await reply(2, { available: true, enabled: true });
  expect(toggle().props["aria-checked"]).toBe(true);
  expect(rendered!.root.findByProps({ role: "alert" }).children).toEqual(["Policy check failed"]);
  expect(toggle().props.disabled).toBe(false);
});

test("failed initial read can be retried without remounting", async () => {
  await mount();
  await act(async () =>
    calls[0]!.reply({ stdout: "", stderr: "Temporary read failure", exitCode: 1 }),
  );
  expect(toggle().props.disabled).toBe(true);
  const retry = rendered!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry"))!;
  await act(async () => retry.props.onClick());
  expect(calls[1]).toMatchObject({ action: "egress.status", params: { udid } });
  await reply(1, { available: true, enabled: false });
  expect(toggle().props.disabled).toBe(false);
  expect(rendered!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

test("a failed post-mutation read offers retry and never displays an unverified policy", async () => {
  await mount();
  await reply(0, { available: true, enabled: false });
  await act(async () => toggle().props.onClick());
  await reply(1, { available: true, enabled: true });
  await act(async () =>
    calls[2]!.reply({ stdout: "", stderr: "Temporary read failure", exitCode: 1 }),
  );
  expect(toggle().props.disabled).toBe(true);
  const retry = rendered!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry"))!;
  await act(async () => retry.props.onClick());
  await reply(3, { available: true, enabled: true });
  expect(toggle().props["aria-checked"]).toBe(true);
  expect(toggle().props.disabled).toBe(false);
});
