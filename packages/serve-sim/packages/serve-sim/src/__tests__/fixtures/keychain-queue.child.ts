import { requestKeychain } from "../../sim-keychain";

const [container, clock, values] = process.argv.slice(2);
Date.now = () => Number(clock);
for (const value of JSON.parse(values!) as string[]) {
  await requestKeychain(
    container!,
    [
      {
        op: "set",
        service: "queue-test",
        account: Buffer.from("token").toString("base64"),
        data: Buffer.from(value).toString("base64"),
      },
    ],
    { timeoutMs: 0, keepQueued: true },
  );
}
