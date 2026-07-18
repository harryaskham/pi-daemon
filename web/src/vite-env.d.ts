/// <reference types="vite/client" />

interface Window {
  __DASH_METRICS__?: import("./performance").DashMetricSnapshot;
}
