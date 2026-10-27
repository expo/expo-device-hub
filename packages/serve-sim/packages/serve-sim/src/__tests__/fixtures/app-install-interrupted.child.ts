import { installAppAsync } from "../../app-install";

await installAppAsync(
  "OWNED-PROBE",
  "/unused",
  Date.now() + 30_000,
  process.env.INSTALL_PREPARE_BIN!,
);
