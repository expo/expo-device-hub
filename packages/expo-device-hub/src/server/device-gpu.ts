import { readGpuInfo } from '@expo/hub-android-utils';

/** Selected-emulator metadata is read on demand, outside device discovery. */
export async function handleDeviceGpuRequest(
  request: Request,
  readGpu = readGpuInfo,
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers });
  }
  const serial = new URL(request.url).searchParams.get('serial');
  if (!serial || !/^emulator-\d+$/.test(serial)) {
    return Response.json({ error: 'Expected an emulator serial' }, { status: 400, headers });
  }
  const gpu = await readGpu(serial, { signal: request.signal });
  return Response.json({ gpu: gpu.value }, { headers });
}
