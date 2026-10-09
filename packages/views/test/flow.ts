import { vi } from "vitest";

/**
 * React Flow measures with browser APIs jsdom lacks (see its testing guide). Call once in
 * `beforeAll`; the stubs give every element a 1000x700 box.
 */
export function installFlowMocks(): void {
  class ResizeObserverStub {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target, contentRect: { width: 1000, height: 700 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
      constructor(_transform?: string) {}
    },
  );
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { get: () => 700, configurable: true },
    offsetWidth: { get: () => 1000, configurable: true },
  });
  (SVGElement.prototype as unknown as { getBBox: () => unknown }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });
}
