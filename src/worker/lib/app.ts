import type { Principal } from "../../shared/contracts";

export interface AppVariables {
  principal: Principal;
  requestId: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
