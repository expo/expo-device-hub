import type { Feature, FeatureState, HubError } from '../types';
export { NOOP_DEVICE_CLIENT as EMPTY_CLIENT } from '../useNoopDeviceClient';
export const testError = (message: string): HubError => ({
  code: 'network',
  message,
  retryable: true,
});
export function testFeature<const D>(
  data: D,
  status?: FeatureState<D>['status'],
): Feature<Exclude<D, undefined>> {
  return {
    status: status ?? (data === undefined ? 'loading' : 'ready'),
    data,
    error: null,
    refresh() {},
  } as Feature<Exclude<D, undefined>>;
}
