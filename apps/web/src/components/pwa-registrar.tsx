"use client";

import { useEffect } from "react";

export function PwaRegistrar() {
  useEffect(() => {
    // isSecureContext rather than an https: check: http://localhost is a secure
    // context and does register a worker, so the https-only test made the PWA
    // impossible to verify anywhere but production. Both browsers that matter
    // here (Edge, Chrome) agree with the spec on this.
    if ("serviceWorker" in navigator && window.isSecureContext)
      void navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }, []);
  return null;
}
