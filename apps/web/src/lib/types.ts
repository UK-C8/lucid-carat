export interface Stone {
  id: string;
  tenant_id: string;
  internal_ref: string | null;
  status: "uploaded" | "grading" | "priced" | "published" | "sold" | "archived";
  shape: string | null;
  carat_weight: string | null;
  lab_grown: string;
  confirmed_color: string | null;
  confirmed_clarity: string | null;
  confirmed_cut: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export interface Certificate {
  id: string;
  lab: string;
  cert_number: string;
  carat_weight: string | null;
  shape: string | null;
  color_grade: string | null;
  clarity_grade: string | null;
  cut_grade: string | null;
  polish: string | null;
  symmetry: string | null;
  fluorescence: string | null;
  measurements_mm: string | null;
  depth_pct: string | null;
  table_pct: string | null;
  lab_grown: string;
  low_confidence_fields: string[] | null;
}

export interface GradingResult {
  id: string;
  source: string;
  model_version: string | null;
  color_grade: string | null;
  clarity_grade: string | null;
  cut_grade: string | null;
  color_confidence: string | null;
  clarity_confidence: string | null;
  cut_confidence: string | null;
  color_disagrees_with_cert: boolean;
  clarity_disagrees_with_cert: boolean;
  cut_disagrees_with_cert: boolean;
}

export interface PriceForecast {
  id: string;
  model_version: string;
  fair_price_usd: string;
  confidence_low_usd: string;
  confidence_high_usd: string;
  confidence_level: string;
  top_drivers: Array<{
    feature: string;
    direction: "up" | "down";
    value: unknown;
    importance: number;
  }>;
  markup_pct: string | null;
}
