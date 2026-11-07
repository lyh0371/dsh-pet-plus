import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
/** 灵魂领域：未命中返回 undefined，命中返回应答。 */
export declare function handleSoulRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined>;
