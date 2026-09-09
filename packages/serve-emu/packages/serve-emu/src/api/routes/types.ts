import type {
  ApiMethod as ContractMethod,
  ApiPath,
} from "../../shared/api-contracts.ts";
import type { ApiRoute } from "../router.ts";

/** A route union whose method is constrained by its shared endpoint path. */
export type ContractApiRoute<Deps> = {
  [Path in ApiPath]: {
    [Method in ContractMethod<Path>]: Omit<
      ApiRoute<Deps>,
      "method" | "path"
    > & {
      readonly method: Method;
      readonly path: Path;
    };
  }[ContractMethod<Path>];
}[ApiPath];
