import type { TrackingSource } from "./tracking-sources";
import type { CaptureProvider } from "./capture-providers";

export type ProjectEventType =
  | "prompt_set_changed"
  | "tracking_sources_changed"
  | "model_detected";

export type ChartAnnotation =
  | {
      type: "prompt_set_changed";
      metricDate: string;
      addedCount: number;
      removedCount: number;
    }
  | {
      type: "tracking_sources_changed";
      id: string;
      metricDate: string;
      occurredAt: string;
      addedSources: TrackingSource[];
      removedSources: TrackingSource[];
    }
  | {
      type: "model_detected";
      id: string;
      metricDate: string;
      occurredAt: string;
      trackingSource: TrackingSource;
      model: string;
    }
  | {
      type: "capture_provider_detected";
      id: string;
      metricDate: string;
      occurredAt: string;
      trackingSource: TrackingSource;
      captureProvider: CaptureProvider;
    };
