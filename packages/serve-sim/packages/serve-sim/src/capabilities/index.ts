export type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityLoadPhase,
  CapabilityOverrides,
  CapabilityScope,
  PreparedCapability,
} from "./runtime/capability";
export {
  assertKnownCapabilities,
  capabilitiesToApply,
  capabilityDefinition,
  clearRegisteredCapabilities,
  missingCapabilities,
  registerCapability,
  registeredCapabilities,
  UnknownCapabilityError,
} from "./runtime/registry";
