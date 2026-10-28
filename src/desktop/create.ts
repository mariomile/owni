import type { DesktopProvider } from "../core/desktop.ts";
import type { DesktopConfig } from "../main/config.ts";
import { LocalDesktopProvider } from "./local-desktop.ts";

/**
 * The screen this configuration asks for apart from the computer's: the person's own Mac
 * (OWNI_DESKTOP=local). The agenti's own screens come with their computers (ADR 0135).
 */
export function createDesktopProvider(config: DesktopConfig): DesktopProvider {
	return new LocalDesktopProvider({ helperPath: config.helperPath });
}
