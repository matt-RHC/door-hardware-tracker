// ─── Shared types for ImportWizard ───

// Domain types imported from canonical source
import type {
  DoorEntry,
  ExtractedHardwareItem,
  HardwareSet,
  FlaggedDoor,
  PageClassification,
} from '@/lib/types';

export type { DoorEntry, ExtractedHardwareItem, HardwareSet, FlaggedDoor, PageClassification };

/** The steps the wizard progresses through. Compare is only shown for revisions. */
export enum WizardStep {
  Upload = 0,
  ScanResults = 1,
  MapColumns = 2,
  Triage = 3,
  Review = 4,
  Products = 5,
  Compare = 6,
  Confirm = 7,
}

/**
 * Steps for the job-based wizard flow (feature-flagged).
 * Upload → Questions → Review → Products → Compare? → Confirm
 */
export enum JobWizardStep {
  Upload = 0,
  Questions = 1,
  Review = 2,
  Products = 3,
  Compare = 4,
  Confirm = 5,
}

// ─── Job-related types ───

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'classifying'
  | 'detecting_columns'
  | 'extracting'
  | 'triaging'
  | 'validating'
  | 'writing_staging'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Per-phase findings published by the job orchestrator so the UI can drive
 *  progressive, data-aware questions while extraction runs. Every sub-object
 *  is optional — each appears once its phase has completed. */
export interface PhaseData {
  classify?: {
    total_pages: number
    schedule_pages: number[]
    hardware_pages: number[]
    skipped_pages: number[]
    /**
     * Pages that *look like* the Opening List (summary mapping door
     * numbers to set IDs). A subset of schedule_pages — broken out so
     * the UI can describe them distinctly from raw door schedule pages.
     */
    opening_list_pages?: number[]
    /** Reference pages (manufacturer/finish/option lists). */
    reference_pages?: number[]
    /**
     * Heuristic warnings about the classification. Empty / missing =
     * no warnings. See src/lib/classification-flags.ts.
     */
    flags?: Array<{
      type: 'sequential_gap' | 'small_job_many_schedule' | 'suspicious_page_type'
      message: string
      suspect_pages: number[]
      classified_as: 'door_schedule' | 'hardware_set'
    }>
    /**
     * Compact per-page info for the "Something's off" drill-down panel.
     * Only includes schedule/hardware/reference pages so we don't ship
     * cover/filler detail through the job poll response.
     */
    page_details?: Array<{
      page: number
      page_type: PageClassification['page_type']
      confidence: number
      preview?: string
      hw_set_ids: string[]
      has_door_numbers: boolean
      section_labels: string[]
      is_false_positive_candidate: boolean
    }>
  }
  extraction?: {
    door_count: number
    hw_set_count: number
    hw_sets: string[]
    sample_doors: Array<{
      door_number: string
      hw_set: string | null
      fire_rating: string | null
    }>
  }
  triage?: {
    fire_rated_count: number
    fire_rated_pct: number
    fire_ratings_found: string[]
    manufacturers_found: string[]
    pair_doors_detected: Array<{ door_a: string; door_b: string | null }>
    orphan_doors: Array<{ door_number: string; reason: string }>
  }
}

export interface JobStatusResponse {
  id: string
  projectId: string
  status: JobStatus
  progress: number
  statusMessage: string | null
  extractionRunId: string | null
  constraintFlags: Record<string, unknown> | null
  classifyResult: ClassifyPagesResponse | null
  extractionSummary: Record<string, unknown> | null
  phaseData: PhaseData
  error: { message: string; phase: string } | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  createdAt: string
}

export interface JobResultsResponse {
  doors: import('@/lib/types').DoorEntry[]
  hardwareSets: import('@/lib/types').HardwareSet[]
  triageResult: TriageResult | null
  constraintFlags: Record<string, unknown> | null
  classifyResult: ClassifyPagesResponse | null
  extractionRunId: string | null
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
    cover_pages: number[];
    other_pages: number[];
    scanned_pages?: number;
  };
  profile?: {
    source: string;
    heading_format: string;
    door_number_format: string;
    table_strategy: string;
    hw_set_count: number;
    door_schedule_pages: number;
    has_reference_tables: boolean;
  };
  extraction_strategy?: string;
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
  triage_error?: boolean;
  triage_error_message?: string;
  retryable?: boolean;
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
  pdfStoragePath: string | null;
  /** PDF bytes — cached once for use in PDFPagePreview (StepReview, DarrinReview). */
  pdfBuffer: ArrayBuffer | null;
  classifyResult: ClassifyPagesResponse | null;
  profile?: ClassifyPagesResponse['profile'];
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
  pdfStoragePath: null,
  pdfBuffer: null,
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
