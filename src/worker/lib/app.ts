import type { Principal } from "../../shared/contracts";
import type { RequestTiming } from "./timing";

export interface AppVariables {
  principal: Principal;
  requestId: string;
  timing: RequestTiming;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
