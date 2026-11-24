import { describe, expect, test } from "bun:test";
import { validateNvidiaGlibc, validateNvidiaPtx } from "../scripts/nvidia-compat.mjs";

describe("NVIDIA driver-compatible PTX", () => {
  test("accepts the CUDA 12.8 ISA supported by R570", () => {
    expect(() => validateNvidiaPtx("// NVRTC output\n.version 8.7\n.target sm_75\n")).not.toThrow();
  });
  test("rejects CUDA 12.9 PTX even when it targets the same GPU", () => {
    expect(() => validateNvidiaPtx(".version 8.8\n.target sm_75\n")).toThrow("R570");
    expect(() => validateNvidiaPtx(".version 9.0\n.target sm_75\n")).toThrow("R570");
  });
  test("rejects missing or malformed ISA metadata", () => {
    expect(() => validateNvidiaPtx(".target sm_75\n")).toThrow();
    expect(() => validateNvidiaPtx(".version unknown\n")).toThrow();
  });
});

describe("NVIDIA prebuilt glibc compatibility", () => {
  test("accepts the measured 2.38 ceiling and older symbols", () => {
    expect(() => validateNvidiaGlibc("GLIBC_2.3.4 GLIBC_2.17 GLIBC_2.38")).not.toThrow();
  });
  test("rejects an ABI increase on a newer release builder", () => {
    expect(() => validateNvidiaGlibc("GLIBC_2.38 GLIBC_2.39")).toThrow("prebuilt limit");
    expect(() => validateNvidiaGlibc("GLIBC_3.0")).toThrow("prebuilt limit");
    expect(() => validateNvidiaGlibc("no version requirements")).toThrow();
  });
});
