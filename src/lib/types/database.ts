export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      attachments: {
        Row: {
          category: string | null
          file_name: string | null
          file_type: string | null
          file_url: string
          id: string
          opening_id: string
          uploaded_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          category?: string | null
          file_name?: string | null
          file_type?: string | null
          file_url: string
          id?: string
          opening_id: string
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          category?: string | null
          file_name?: string | null
          file_type?: string | null
          file_url?: string
          id?: string
          opening_id?: string
          uploaded_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attachments_opening_id_fkey"
            columns: ["opening_id"]
            isOneToOne: false
            referencedRelation: "openings"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_progress: {
        Row: {
          checked: boolean | null
          checked_at: string | null
          checked_by: string | null
          created_at: string | null
          id: string
          installed: boolean | null
          installed_at: string | null
          installed_by: string | null
          item_id: string
          leaf_index: number
          notes: string | null
          opening_id: string
          pre_install: boolean | null
          pre_install_at: string | null
          pre_install_by: string | null
          qa_qc: boolean | null
          qa_qc_at: string | null
          qa_qc_by: string | null
          received: boolean | null
          received_at: string | null
          received_by: string | null
        }
        Insert: {
          checked?: boolean | null
          checked_at?: string | null
          checked_by?: string | null
          created_at?: string | null
          id?: string
          installed?: boolean | null
          installed_at?: string | null
          installed_by?: string | null
          item_id: string
          leaf_index?: number
          notes?: string | null
          opening_id: string
          pre_install?: boolean | null
          pre_install_at?: string | null
          pre_install_by?: string | null
          qa_qc?: boolean | null
          qa_qc_at?: string | null
          qa_qc_by?: string | null
          received?: boolean | null
          received_at?: string | null
          received_by?: string | null
        }
        Update: {
          checked?: boolean | null
          checked_at?: string | null
          checked_by?: string | null
          created_at?: string | null
          id?: string
          installed?: boolean | null
          installed_at?: string | null
          installed_by?: string | null
          item_id?: string
          leaf_index?: number
          notes?: string | null
          opening_id?: string
          pre_install?: boolean | null
          pre_install_at?: string | null
          pre_install_by?: string | null
          qa_qc?: boolean | null
          qa_qc_at?: string | null
          qa_qc_by?: string | null
          received?: boolean | null
          received_at?: string | null
          received_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "checklist_progress_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "hardware_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_progress_opening_id_fkey"
            columns: ["opening_id"]
            isOneToOne: false
            referencedRelation: "openings"
            referencedColumns: ["id"]
          },
        ]
      }
      deliveries: {
        Row: {
          actual_date: string | null
          created_at: string | null
          description: string | null
          expected_date: string | null
          id: string
          items_summary: string | null
          notes: string | null
          po_number: string | null
          project_id: string
          quantity: number | null
          status: string | null
          tracking_number: string | null
          updated_at: string | null
          vendor: string | null
        }
        Insert: {
          actual_date?: string | null
          created_at?: string | null
          description?: string | null
          expected_date?: string | null
          id?: string
          items_summary?: string | null
          notes?: string | null
          po_number?: string | null
          project_id: string
          quantity?: number | null
          status?: string | null
          tracking_number?: string | null
          updated_at?: string | null
          vendor?: string | null
        }
        Update: {
          actual_date?: string | null
          created_at?: string | null
          description?: string | null
          expected_date?: string | null
          id?: string
          items_summary?: string | null
          notes?: string | null
          po_number?: string | null
          project_id?: string
          quantity?: number | null
          status?: string | null
          tracking_number?: string | null
          updated_at?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_corrections: {
        Row: {
          corrected_at: string | null
          corrected_by: string | null
          corrected_value: string | null
          correction_type: string | null
          door_number: string | null
          extraction_run_id: string
          field_name: string
          id: string
          original_value: string | null
          project_id: string
        }
        Insert: {
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_value?: string | null
          correction_type?: string | null
          door_number?: string | null
          extraction_run_id: string
          field_name: string
          id?: string
          original_value?: string | null
          project_id: string
        }
        Update: {
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_value?: string | null
          correction_type?: string | null
          door_number?: string | null
          extraction_run_id?: string
          field_name?: string
          id?: string
          original_value?: string | null
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "extraction_corrections_extraction_run_id_fkey"
            columns: ["extraction_run_id"]
            isOneToOne: false
            referencedRelation: "extraction_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_corrections_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_decisions: {
        Row: {
          answer: string
          applied_count: number | null
          created_at: string | null
          created_by: string | null
          decision_type: string
          id: string
          item_category: string | null
          item_name: string | null
          project_id: string
          question_text: string | null
          resolved_value: Json | null
          set_id: string | null
        }
        Insert: {
          answer: string
          applied_count?: number | null
          created_at?: string | null
          created_by?: string | null
          decision_type: string
          id?: string
          item_category?: string | null
          item_name?: string | null
          project_id: string
          question_text?: string | null
          resolved_value?: Json | null
          set_id?: string | null
        }
        Update: {
          answer?: string
          applied_count?: number | null
          created_at?: string | null
          created_by?: string | null
          decision_type?: string
          id?: string
          item_category?: string | null
          item_name?: string | null
          project_id?: string
          question_text?: string | null
          resolved_value?: Json | null
          set_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extraction_decisions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_jobs: {
        Row: {
          id: string
          project_id: string
          created_by: string
          status: string
          progress: number
          status_message: string | null
          pdf_storage_path: string
          pdf_hash: string | null
          pdf_page_count: number | null
          extraction_run_id: string | null
          classify_result: Json | null
          detect_result: Json | null
          extraction_summary: Json | null
          constraint_flags: Json | null
          started_at: string | null
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          error_phase: string | null
          retry_count: number | null
          deep_extraction: boolean
          auto_triggered: boolean
          extraction_confidence: Json | null
          reconciliation_result: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          created_by: string
          status?: string
          progress?: number
          status_message?: string | null
          pdf_storage_path: string
          pdf_hash?: string | null
          pdf_page_count?: number | null
          extraction_run_id?: string | null
          classify_result?: Json | null
          detect_result?: Json | null
          extraction_summary?: Json | null
          constraint_flags?: Json | null
          started_at?: string | null
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          error_phase?: string | null
          retry_count?: number | null
          deep_extraction?: boolean
          auto_triggered?: boolean
          extraction_confidence?: Json | null
          reconciliation_result?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          created_by?: string
          status?: string
          progress?: number
          status_message?: string | null
          pdf_storage_path?: string
          pdf_hash?: string | null
          pdf_page_count?: number | null
          extraction_run_id?: string | null
          classify_result?: Json | null
          detect_result?: Json | null
          extraction_summary?: Json | null
          constraint_flags?: Json | null
          started_at?: string | null
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          error_phase?: string | null
          retry_count?: number | null
          deep_extraction?: boolean
          auto_triggered?: boolean
          extraction_confidence?: Json | null
          reconciliation_result?: Json | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "extraction_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_jobs_extraction_run_id_fkey"
            columns: ["extraction_run_id"]
            isOneToOne: false
            referencedRelation: "extraction_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      extraction_runs: {
        Row: {
          completed_at: string | null
          confidence: string | null
          confidence_score: number | null
          created_at: string | null
          created_by: string | null
          doors_extracted: number | null
          doors_flagged: number | null
          duration_ms: number | null
          error_message: string | null
          extraction_method: string | null
          extraction_notes: string[] | null
          hw_sets_extracted: number | null
          id: string
          job_id: string | null
          pdf_hash: string | null
          pdf_page_count: number | null
          pdf_source_type: string | null
          pdf_storage_path: string | null
          project_id: string
          promoted_at: string | null
          promoted_by: string | null
          reference_codes_extracted: number | null
          started_at: string | null
          status: string
        }
        Insert: {
          completed_at?: string | null
          confidence?: string | null
          confidence_score?: number | null
          created_at?: string | null
          created_by?: string | null
          doors_extracted?: number | null
          doors_flagged?: number | null
          duration_ms?: number | null
          error_message?: string | null
          extraction_method?: string | null
          extraction_notes?: string[] | null
          hw_sets_extracted?: number | null
          id?: string
          job_id?: string | null
          pdf_hash?: string | null
          pdf_page_count?: number | null
          pdf_source_type?: string | null
          pdf_storage_path?: string | null
          project_id: string
          promoted_at?: string | null
          promoted_by?: string | null
          reference_codes_extracted?: number | null
          started_at?: string | null
          status?: string
        }
        Update: {
          completed_at?: string | null
          confidence?: string | null
          confidence_score?: number | null
          created_at?: string | null
          created_by?: string | null
          doors_extracted?: number | null
          doors_flagged?: number | null
          duration_ms?: number | null
          error_message?: string | null
          extraction_method?: string | null
          extraction_notes?: string[] | null
          hw_sets_extracted?: number | null
          id?: string
          job_id?: string | null
          pdf_hash?: string | null
          pdf_page_count?: number | null
          pdf_source_type?: string | null
          pdf_storage_path?: string | null
          project_id?: string
          promoted_at?: string | null
          promoted_by?: string | null
          reference_codes_extracted?: number | null
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "extraction_runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extraction_runs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "extraction_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_user_constraints: {
        Row: {
          id: string
          job_id: string
          question_key: string
          answer_value: Json
          answered_at: string
        }
        Insert: {
          id?: string
          job_id: string
          question_key: string
          answer_value: Json
          answered_at?: string
        }
        Update: {
          id?: string
          job_id?: string
          question_key?: string
          answer_value?: Json
          answered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_user_constraints_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "extraction_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      hardware_items: {
        Row: {
          created_at: string | null
          finish: string | null
          id: string
          install_type: string | null
          leaf_side: string | null
          manufacturer: string | null
          model: string | null
          name: string
          opening_id: string
          options: string | null
          qty: number | null
          qty_door_count: number | null
          qty_source: string | null
          qty_total: number | null
          sort_order: number | null
        }
        Insert: {
          created_at?: string | null
          finish?: string | null
          id?: string
          install_type?: string | null
          leaf_side?: string | null
          manufacturer?: string | null
          model?: string | null
          name: string
          opening_id: string
          options?: string | null
          qty?: number | null
          qty_door_count?: number | null
          qty_source?: string | null
          qty_total?: number | null
          sort_order?: number | null
        }
        Update: {
          created_at?: string | null
          finish?: string | null
          id?: string
          install_type?: string | null
          leaf_side?: string | null
          manufacturer?: string | null
          model?: string | null
          name?: string
          opening_id?: string
          options?: string | null
          qty?: number | null
          qty_door_count?: number | null
          qty_source?: string | null
          qty_total?: number | null
          sort_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "hardware_items_opening_id_fkey"
            columns: ["opening_id"]
            isOneToOne: false
            referencedRelation: "openings"
            referencedColumns: ["id"]
          },
        ]
      }
      issues: {
        Row: {
          assigned_to: string | null
          created_at: string | null
          date_reported: string | null
          date_resolved: string | null
          description: string
          door_number: string | null
          hardware_item_id: string | null
          hardware_item_name: string | null
          id: string
          issue_id_short: string | null
          notes: string | null
          opening_id: string | null
          project_id: string
          reported_by: string | null
          severity: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string | null
          date_reported?: string | null
          date_resolved?: string | null
          description: string
          door_number?: string | null
          hardware_item_id?: string | null
          hardware_item_name?: string | null
          id?: string
          issue_id_short?: string | null
          notes?: string | null
          opening_id?: string | null
          project_id: string
          reported_by?: string | null
          severity?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          created_at?: string | null
          date_reported?: string | null
          date_resolved?: string | null
          description?: string
          door_number?: string | null
          hardware_item_id?: string | null
          hardware_item_name?: string | null
          id?: string
          issue_id_short?: string | null
          notes?: string | null
          opening_id?: string | null
          project_id?: string
          reported_by?: string | null
          severity?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "issues_hardware_item_id_fkey"
            columns: ["hardware_item_id"]
            isOneToOne: false
            referencedRelation: "hardware_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_opening_id_fkey"
            columns: ["opening_id"]
            isOneToOne: false
            referencedRelation: "openings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      openings: {
        Row: {
          created_at: string | null
          door_number: string
          door_type: string | null
          fire_rating: string | null
          frame_type: string | null
          hand: string | null
          hw_heading: string | null
          hw_set: string | null
          id: string
          leaf_count: number
          location: string | null
          notes: string | null
          pdf_page: number | null
          project_id: string
        }
        Insert: {
          created_at?: string | null
          door_number: string
          door_type?: string | null
          fire_rating?: string | null
          frame_type?: string | null
          hand?: string | null
          hw_heading?: string | null
          hw_set?: string | null
          id?: string
          leaf_count?: number
          location?: string | null
          notes?: string | null
          pdf_page?: number | null
          project_id: string
        }
        Update: {
          created_at?: string | null
          door_number?: string
          door_type?: string | null
          fire_rating?: string | null
          frame_type?: string | null
          hand?: string | null
          hw_heading?: string | null
          hw_set?: string | null
          id?: string
          leaf_count?: number
          location?: string | null
          notes?: string | null
          pdf_page?: number | null
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "openings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          id: string
          invited_email: string | null
          joined_at: string | null
          project_id: string
          role: string | null
          user_id: string | null
        }
        Insert: {
          id?: string
          invited_email?: string | null
          joined_at?: string | null
          project_id: string
          role?: string | null
          user_id?: string | null
        }
        Update: {
          id?: string
          invited_email?: string | null
          joined_at?: string | null
          project_id?: string
          role?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          address: string | null
          architect: string | null
          created_at: string | null
          created_by: string | null
          general_contractor: string | null
          id: string
          job_number: string | null
          last_pdf_hash: string | null
          last_pdf_uploaded_at: string | null
          name: string
          pdf_page_count: number | null
          pdf_storage_path: string | null
          submittal_date: string | null
        }
        Insert: {
          address?: string | null
          architect?: string | null
          created_at?: string | null
          created_by?: string | null
          general_contractor?: string | null
          id?: string
          job_number?: string | null
          last_pdf_hash?: string | null
          last_pdf_uploaded_at?: string | null
          name: string
          pdf_page_count?: number | null
          pdf_storage_path?: string | null
          submittal_date?: string | null
        }
        Update: {
          address?: string | null
          architect?: string | null
          created_at?: string | null
          created_by?: string | null
          general_contractor?: string | null
          id?: string
          job_number?: string | null
          last_pdf_hash?: string | null
          last_pdf_uploaded_at?: string | null
          name?: string
          pdf_page_count?: number | null
          pdf_storage_path?: string | null
          submittal_date?: string | null
        }
        Relationships: []
      }
      punchy_logs: {
        Row: {
          checkpoint: number
          created_at: string
          extraction_run_id: string | null
          id: string
          input_snapshot: Json | null
          input_tokens: number | null
          latency_ms: number | null
          output_tokens: number | null
          parse_ok: boolean
          project_id: string | null
          response: Json | null
        }
        Insert: {
          checkpoint: number
          created_at?: string
          extraction_run_id?: string | null
          id?: string
          input_snapshot?: Json | null
          input_tokens?: number | null
          latency_ms?: number | null
          output_tokens?: number | null
          parse_ok?: boolean
          project_id?: string | null
          response?: Json | null
        }
        Update: {
          checkpoint?: number
          created_at?: string
          extraction_run_id?: string | null
          id?: string
          input_snapshot?: Json | null
          input_tokens?: number | null
          latency_ms?: number | null
          output_tokens?: number | null
          parse_ok?: boolean
          project_id?: string | null
          response?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "punchy_logs_extraction_run_id_fkey"
            columns: ["extraction_run_id"]
            isOneToOne: false
            referencedRelation: "extraction_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "punchy_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      reference_codes: {
        Row: {
          code: string
          code_type: string
          created_at: string | null
          full_name: string
          id: string
          project_id: string
          source: string
          updated_at: string | null
        }
        Insert: {
          code: string
          code_type: string
          created_at?: string | null
          full_name: string
          id?: string
          project_id: string
          source?: string
          updated_at?: string | null
        }
        Update: {
          code?: string
          code_type?: string
          created_at?: string | null
          full_name?: string
          id?: string
          project_id?: string
          source?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reference_codes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      staging_hardware_items: {
        Row: {
          created_at: string | null
          extraction_run_id: string
          finish: string | null
          id: string
          leaf_side: string | null
          manufacturer: string | null
          model: string | null
          name: string
          options: string | null
          qty: number | null
          qty_door_count: number | null
          qty_source: string | null
          qty_total: number | null
          sort_order: number | null
          staging_opening_id: string
        }
        Insert: {
          created_at?: string | null
          extraction_run_id: string
          finish?: string | null
          id?: string
          leaf_side?: string | null
          manufacturer?: string | null
          model?: string | null
          name: string
          options?: string | null
          qty?: number | null
          qty_door_count?: number | null
          qty_source?: string | null
          qty_total?: number | null
          sort_order?: number | null
          staging_opening_id: string
        }
        Update: {
          created_at?: string | null
          extraction_run_id?: string
          finish?: string | null
          id?: string
          leaf_side?: string | null
          manufacturer?: string | null
          model?: string | null
          name?: string
          options?: string | null
          qty?: number | null
          qty_door_count?: number | null
          qty_source?: string | null
          qty_total?: number | null
          sort_order?: number | null
          staging_opening_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staging_hardware_items_extraction_run_id_fkey"
            columns: ["extraction_run_id"]
            isOneToOne: false
            referencedRelation: "extraction_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staging_hardware_items_staging_opening_id_fkey"
            columns: ["staging_opening_id"]
            isOneToOne: false
            referencedRelation: "staging_openings"
            referencedColumns: ["id"]
          },
        ]
      }
      staging_openings: {
        Row: {
          created_at: string | null
          door_number: string
          door_type: string | null
          extraction_run_id: string
          field_confidence: Json | null
          fire_rating: string | null
          flag_reason: string | null
          frame_type: string | null
          hand: string | null
          hw_heading: string | null
          hw_set: string | null
          id: string
          is_flagged: boolean | null
          leaf_count: number
          location: string | null
          notes: string | null
          pdf_page: number | null
          project_id: string
        }
        Insert: {
          created_at?: string | null
          door_number: string
          door_type?: string | null
          extraction_run_id: string
          field_confidence?: Json | null
          fire_rating?: string | null
          flag_reason?: string | null
          frame_type?: string | null
          hand?: string | null
          hw_heading?: string | null
          hw_set?: string | null
          id?: string
          is_flagged?: boolean | null
          leaf_count?: number
          location?: string | null
          notes?: string | null
          pdf_page?: number | null
          project_id: string
        }
        Update: {
          created_at?: string | null
          door_number?: string
          door_type?: string | null
          extraction_run_id?: string
          field_confidence?: Json | null
          fire_rating?: string | null
          flag_reason?: string | null
          frame_type?: string | null
          hand?: string | null
          hw_heading?: string | null
          hw_set?: string | null
          id?: string
          is_flagged?: boolean | null
          leaf_count?: number
          location?: string | null
          notes?: string | null
          pdf_page?: number | null
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staging_openings_extraction_run_id_fkey"
            columns: ["extraction_run_id"]
            isOneToOne: false
            referencedRelation: "extraction_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staging_openings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      tracking_items: {
        Row: {
          area: string | null
          category: string | null
          code_evidence: Json | null
          created_at: string | null
          date_identified: string | null
          date_resolved: string | null
          description: string | null
          due_date: string | null
          id: string
          last_verified_at: string | null
          metric_accuracy_pct: number | null
          metric_build_commit: string | null
          metric_doors_expected: number | null
          metric_doors_extracted: number | null
          metric_duration_ms: number | null
          metric_pdf_name: string | null
          metric_sets_expected: number | null
          metric_sets_extracted: number | null
          notes: string | null
          priority: string | null
          record_type: string
          relevance: string | null
          relevance_notes: string | null
          resolved_commit: string | null
          resolved_pr: number | null
          session_decisions: string | null
          session_refs: string[] | null
          session_status: string | null
          session_topics: string | null
          source_imported_at: string | null
          source_row_id: number | null
          source_sheet_id: number | null
          status: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          area?: string | null
          category?: string | null
          code_evidence?: Json | null
          created_at?: string | null
          date_identified?: string | null
          date_resolved?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          last_verified_at?: string | null
          metric_accuracy_pct?: number | null
          metric_build_commit?: string | null
          metric_doors_expected?: number | null
          metric_doors_extracted?: number | null
          metric_duration_ms?: number | null
          metric_pdf_name?: string | null
          metric_sets_expected?: number | null
          metric_sets_extracted?: number | null
          notes?: string | null
          priority?: string | null
          record_type: string
          relevance?: string | null
          relevance_notes?: string | null
          resolved_commit?: string | null
          resolved_pr?: number | null
          session_decisions?: string | null
          session_refs?: string[] | null
          session_status?: string | null
          session_topics?: string | null
          source_imported_at?: string | null
          source_row_id?: number | null
          source_sheet_id?: number | null
          status?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          area?: string | null
          category?: string | null
          code_evidence?: Json | null
          created_at?: string | null
          date_identified?: string | null
          date_resolved?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          last_verified_at?: string | null
          metric_accuracy_pct?: number | null
          metric_build_commit?: string | null
          metric_doors_expected?: number | null
          metric_doors_extracted?: number | null
          metric_duration_ms?: number | null
          metric_pdf_name?: string | null
          metric_sets_expected?: number | null
          metric_sets_extracted?: number | null
          notes?: string | null
          priority?: string | null
          record_type?: string
          relevance?: string | null
          relevance_notes?: string | null
          resolved_commit?: string | null
          resolved_pr?: number | null
          session_decisions?: string | null
          session_refs?: string[] | null
          session_status?: string | null
          session_topics?: string | null
          source_imported_at?: string | null
          source_row_id?: number | null
          source_sheet_id?: number | null
          status?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cleanup_old_staging: {
        Args: { p_retention_days?: number }
        Returns: number
      }
      merge_extraction: {
        Args: { p_extraction_run_id: string; p_user_id: string }
        Returns: Json
      }
      promote_extraction: {
        Args: { p_extraction_run_id: string; p_user_id: string }
        Returns: Json
      }
      write_staging_data: {
        Args: { p_extraction_run_id: string; p_project_id: string; p_payload: Json }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

// ─── Convenience row type aliases ────────────────────────────────────────────
// These are re-exported so callers don't have to write the full
// Database['public']['Tables']['foo']['Row'] path everywhere.

export type Project = Database['public']['Tables']['projects']['Row']
export type ProjectInsert = Database['public']['Tables']['projects']['Insert']
export type ProjectUpdate = Database['public']['Tables']['projects']['Update']

export type ProjectMember = Database['public']['Tables']['project_members']['Row']
export type ProjectMemberInsert = Database['public']['Tables']['project_members']['Insert']
export type ProjectMemberUpdate = Database['public']['Tables']['project_members']['Update']

export type Opening = Database['public']['Tables']['openings']['Row']
export type OpeningInsert = Database['public']['Tables']['openings']['Insert']
export type OpeningUpdate = Database['public']['Tables']['openings']['Update']

export type HardwareItem = Database['public']['Tables']['hardware_items']['Row']
export type HardwareItemInsert = Database['public']['Tables']['hardware_items']['Insert']
export type HardwareItemUpdate = Database['public']['Tables']['hardware_items']['Update']

export type ChecklistProgress = Database['public']['Tables']['checklist_progress']['Row']
export type ChecklistProgressInsert = Database['public']['Tables']['checklist_progress']['Insert']
export type ChecklistProgressUpdate = Database['public']['Tables']['checklist_progress']['Update']

export type Attachment = Database['public']['Tables']['attachments']['Row']
export type AttachmentInsert = Database['public']['Tables']['attachments']['Insert']
export type AttachmentUpdate = Database['public']['Tables']['attachments']['Update']

export type Issue = Database['public']['Tables']['issues']['Row']
export type IssueInsert = Database['public']['Tables']['issues']['Insert']
export type IssueUpdate = Database['public']['Tables']['issues']['Update']

export type Delivery = Database['public']['Tables']['deliveries']['Row']
export type DeliveryInsert = Database['public']['Tables']['deliveries']['Insert']
export type DeliveryUpdate = Database['public']['Tables']['deliveries']['Update']

export type TrackingItem = Database['public']['Tables']['tracking_items']['Row']
export type TrackingItemInsert = Database['public']['Tables']['tracking_items']['Insert']
export type TrackingItemUpdate = Database['public']['Tables']['tracking_items']['Update']

// --- Shared composite types ---

/** HardwareItem joined with its checklist_progress row. */
export interface HardwareItemWithProgress extends HardwareItem {
  progress?: ChecklistProgress
}

/** HardwareItem row shape returned by Supabase joins that embed checklist_progress. */
export interface HardwareItemRow {
  id: string
  install_type: 'bench' | 'field' | null
  checklist_progress: Array<{
    received: boolean
    pre_install: boolean
    installed: boolean
    qa_qc: boolean
  }>
}

/** Opening row shape returned by Supabase joins that embed hardware_items. */
export interface OpeningRow {
  id: string
  door_number: string
  hw_set: string | null
  hw_heading: string | null
  location: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
  hardware_items: HardwareItemRow[]
}

/** Opening row shape with full hardware items for CSV export. */
export interface OpeningWithHardware {
  id: string
  door_number: string
  hw_set: string | null
  hw_heading: string | null
  location: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
  notes: string | null
  hardware_items: Array<{
    id: string
    name: string
    qty: number
    manufacturer: string | null
    model: string | null
    finish: string | null
    sort_order: number
    checklist_progress: Array<{ checked: boolean }>
  }>
}
