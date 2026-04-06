// ─── Shared types for ImportWizard ───

/** The five steps the wizard progresses through. */
export enum WizardStep {
  Upload = 0,
  MapColumns = 1,
  Triage = 2,
  Review = 3,
  Confirm = 4,
}

// ─── Domain types (reused from PDFUploadModal / parse-pdf) ───

export interface HardwareItem {
  qty: number;
  name: string;
  model: string;
  finish: string;
  manufacturer: string;
}

export interface HardwareSet {
  set_id: string;
  heading: string;
  items: HardwareItem[];
}

export interface DoorEntry {
  door_number: string;
  hw_set: string;
  location: string;
  door_type: string;
  frame_type: string;
  fire_rating: string;
  hand: string;
  field_confidence?: Record<string, number>;
}

export interface FlaggedDoor {
  door_number: string;
  reason: string;
  confidence: number;
}

// ─── API response types ───

/** Response from /api/classify-pages */
export interface ClassifyPagesResponse {
  pages: PageClassification[];
  summary: {
    total_pages: number;
    door_schedule_pages: number[];
    hardware_set_pages: number[];
    submittal_pages: number[];
    other_pages: number[];
  };
}

export interface PageClassification {
  page_number: number;
  page_type: "door_schedule" | "hardware_sets" | "submittal" | "cover" | "other";
  confidence: number;
}

/** Response from /api/detect-mapping */
export interface DetectMappingResponse {
  columns: DetectedColumn[];
  best_door_schedule_page: number;
  raw_headers: string[];
}

export interface DetectedColumn {
  source_header: string;
  mapped_field: keyof DoorEntry | null;
  confidence: number;
}

/** Column mapping: source header -> target field */
export interface ColumnMapping {
  source_header: string;
  mapped_field: keyof DoorEntry | null;
}

// ─── Triage types ───

export interface TriageResult {
  doors_found: number;
  by_others: number;
  rejected: number;
  accepted: DoorEntry[];
  flagged: FlaggedDoor[];
}

// ─── Staging / extraction run types ───

export interface ExtractionRun {
  id: string;
  project_id: string;
  status: "pending" | "staged" | "promoted" | "rejected";
  created_at: string;
}

// ─── Wizard state ───

export interface WizardState {
  currentStep: WizardStep;

  // Step 1: Upload
  file: File | null;
  classifyResult: ClassifyPagesResponse | null;
  hasExistingData: boolean;

  // Step 2: Map Columns
  detectResult: DetectMappingResponse | null;
  columnMappings: ColumnMapping[];

  // Step 3: Triage
  triageResult: TriageResult | null;

  // Step 4: Review
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];

  // Step 5: Confirm
  extractionRunId: string | null;
  saveComplete: boolean;

  // Shared
  loading: boolean;
  error: string | null;
  progress: number;
  status: string;
}

export const INITIAL_WIZARD_STATE: WizardState = {
  currentStep: WizardStep.Upload,
  file: null,
  classifyResult: null,
  hasExistingData: false,
  detectResult: null,
  columnMappings: [],
  triageResult: null,
  doors: [],
  hardwareSets: [],
  extractionRunId: null,
  saveComplete: false,
  loading: false,
  error: null,
  progress: 0,
  status: "",
};
