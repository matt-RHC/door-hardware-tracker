export type Database = {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string
          name: string
          job_number: string | null
          general_contractor: string | null
          architect: string | null
          address: string | null
          submittal_date: string | null
          created_at: string
          created_by: string | null
          smartsheet_sheet_id: number | null
          smartsheet_last_synced: string | null
          smartsheet_webhook_id: number | null
          smartsheet_submittal_sheet_id: number | null
          smartsheet_delivery_sheet_id: number | null
          smartsheet_issues_sheet_id: number | null
          smartsheet_folder_id: number | null
        }
        Insert: {
          id?: string
          name: string
          job_number?: string | null
          general_contractor?: string | null
          architect?: string | null
          address?: string | null
          submittal_date?: string | null
          created_at?: string
          created_by?: string | null
          smartsheet_sheet_id?: number | null
          smartsheet_last_synced?: string | null
          smartsheet_webhook_id?: number | null
          smartsheet_submittal_sheet_id?: number | null
          smartsheet_delivery_sheet_id?: number | null
          smartsheet_issues_sheet_id?: number | null
          smartsheet_folder_id?: number | null
        }
        Update: {
          id?: string
          name?: string
          job_number?: string | null
          general_contractor?: string | null
          architect?: string | null
          address?: string | null
          submittal_date?: string | null
          created_at?: string
          created_by?: string | null
          smartsheet_sheet_id?: number | null
          smartsheet_last_synced?: string | null
          smartsheet_webhook_id?: number | null
          smartsheet_submittal_sheet_id?: number | null
          smartsheet_delivery_sheet_id?: number | null
          smartsheet_issues_sheet_id?: number | null
          smartsheet_folder_id?: number | null
        }
      }
      project_members: {
        Row: {
          id: string
          project_id: string
          user_id: string
          role: 'admin' | 'member'
          invited_email: string | null
          joined_at: string
        }
        Insert: {
          id?: string
          project_id: string
          user_id: string
          role?: 'admin' | 'member'
          invited_email?: string | null
          joined_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          user_id?: string
          role?: 'admin' | 'member'
          invited_email?: string | null
          joined_at?: string
        }
      }
      openings: {
        Row: {
          id: string
          project_id: string
          door_number: string
          hw_set: string | null
          hw_heading: string | null
          location: string | null
          door_type: string | null
          frame_type: string | null
          fire_rating: string | null
          hand: string | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          door_number: string
          hw_set?: string | null
          hw_heading?: string | null
          location?: string | null
          door_type?: string | null
          frame_type?: string | null
          fire_rating?: string | null
          hand?: string | null
          notes?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          door_number?: string
          hw_set?: string | null
          hw_heading?: string | null
          location?: string | null
          door_type?: string | null
          frame_type?: string | null
          fire_rating?: string | null
          hand?: string | null
          notes?: string | null
          created_at?: string
        }
      }
      hardware_items: {
        Row: {
          id: string
          opening_id: string
          name: string
          qty: number
          manufacturer: string | null
          model: string | null
          finish: string | null
          options: string | null
          sort_order: number
          install_type: 'bench' | 'field' | null
          created_at: string
        }
        Insert: {
          id?: string
          opening_id: string
          name: string
          qty?: number
          manufacturer?: string | null
          model?: string | null
          finish?: string | null
          options?: string | null
          sort_order?: number
          install_type?: 'bench' | 'field' | null
          created_at?: string
        }
        Update: {
          id?: string
          opening_id?: string
          name?: string
          qty?: number
          manufacturer?: string | null
          model?: string | null
          finish?: string | null
          options?: string | null
          sort_order?: number
          install_type?: 'bench' | 'field' | null
          created_at?: string
        }
      }
      checklist_progress: {
        Row: {
          id: string
          opening_id: string
          item_id: string
          checked: boolean
          checked_by: string | null
          checked_at: string | null
          received: boolean
          received_by: string | null
          received_at: string | null
          pre_install: boolean
          pre_install_by: string | null
          pre_install_at: string | null
          installed: boolean
          installed_by: string | null
          installed_at: string | null
          qa_qc: boolean
          qa_qc_by: string | null
          qa_qc_at: string | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          opening_id: string
          item_id: string
          checked?: boolean
          checked_by?: string | null
          checked_at?: string | null
          received?: boolean
          received_by?: string | null
          received_at?: string | null
          pre_install?: boolean
          pre_install_by?: string | null
          pre_install_at?: string | null
          installed?: boolean
          installed_by?: string | null
          installed_at?: string | null
          qa_qc?: boolean
          qa_qc_by?: string | null
          qa_qc_at?: string | null
          notes?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          opening_id?: string
          item_id?: string
          checked?: boolean
          checked_by?: string | null
          checked_at?: string | null
          received?: boolean
          received_by?: string | null
          received_at?: string | null
          pre_install?: boolean
          pre_install_by?: string | null
          pre_install_at?: string | null
          installed?: boolean
          installed_by?: string | null
          installed_at?: string | null
          qa_qc?: boolean
          qa_qc_by?: string | null
          qa_qc_at?: string | null
          notes?: string | null
          created_at?: string
        }
      }
      attachments: {
        Row: {
          id: string
          opening_id: string
          file_url: string
          file_name: string | null
          file_type: string | null
          category: 'floor_plan' | 'door_drawing' | 'frame_drawing' | 'general'
          uploaded_by: string | null
          uploaded_at: string
        }
        Insert: {
          id?: string
          opening_id: string
          file_url: string
          file_name?: string | null
          file_type?: string | null
          category?: 'floor_plan' | 'door_drawing' | 'frame_drawing' | 'general'
          uploaded_by?: string | null
          uploaded_at?: string
        }
        Update: {
          id?: string
          opening_id?: string
          file_url?: string
          file_name?: string | null
          file_type?: string | null
          category?: 'floor_plan' | 'door_drawing' | 'frame_drawing' | 'general'
          uploaded_by?: string | null
          uploaded_at?: string
        }
      }
      issues: {
        Row: {
          id: string
          project_id: string
          issue_id_short: string
          door_number: string | null
          hardware_item: string | null
          description: string
          severity: 'low' | 'medium' | 'high' | 'critical'
          status: 'open' | 'in_progress' | 'resolved' | 'closed'
          assigned_to: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          issue_id_short: string
          door_number?: string | null
          hardware_item?: string | null
          description: string
          severity?: 'low' | 'medium' | 'high' | 'critical'
          status?: 'open' | 'in_progress' | 'resolved' | 'closed'
          assigned_to?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          issue_id_short?: string
          door_number?: string | null
          hardware_item?: string | null
          description?: string
          severity?: 'low' | 'medium' | 'high' | 'critical'
          status?: 'open' | 'in_progress' | 'resolved' | 'closed'
          assigned_to?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      deliveries: {
        Row: {
          id: string
          project_id: string
          po_number: string | null
          vendor: string | null
          items_description: string | null
          expected_date: string | null
          actual_date: string | null
          status: 'ordered' | 'shipped' | 'delivered' | 'partial' | 'delayed'
          notes: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          po_number?: string | null
          vendor?: string | null
          items_description?: string | null
          expected_date?: string | null
          actual_date?: string | null
          status?: 'ordered' | 'shipped' | 'delivered' | 'partial' | 'delayed'
          notes?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          po_number?: string | null
          vendor?: string | null
          items_description?: string | null
          expected_date?: string | null
          actual_date?: string | null
          status?: 'ordered' | 'shipped' | 'delivered' | 'partial' | 'delayed'
          notes?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      smartsheet_row_map: {
        Row: {
          id: string
          sheet_type: string
          local_record_id: string
          smartsheet_sheet_id: number
          smartsheet_row_id: number
          sync_hash: string | null
          last_synced: string
        }
        Insert: {
          id?: string
          sheet_type: string
          local_record_id: string
          smartsheet_sheet_id: number
          smartsheet_row_id: number
          sync_hash?: string | null
          last_synced?: string
        }
        Update: {
          id?: string
          sheet_type?: string
          local_record_id?: string
          smartsheet_sheet_id?: number
          smartsheet_row_id?: number
          sync_hash?: string | null
          last_synced?: string
        }
      }
      smartsheet_webhooks: {
        Row: {
          id: string
          project_id: string
          sheet_type: string
          smartsheet_webhook_id: number
          smartsheet_sheet_id: number
          active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          sheet_type: string
          smartsheet_webhook_id: number
          smartsheet_sheet_id: number
          active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          sheet_type?: string
          smartsheet_webhook_id?: number
          smartsheet_sheet_id?: number
          active?: boolean
          created_at?: string
        }
      }
      smartsheet_portfolio: {
        Row: {
          id: string
          project_id: string
          smartsheet_row_id: number | null
          last_synced: string | null
        }
        Insert: {
          id?: string
          project_id: string
          smartsheet_row_id?: number | null
          last_synced?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          smartsheet_row_id?: number | null
          last_synced?: string | null
        }
      }
    }
    Views: {}
    Functions: {}
    Enums: {}
  }
}

// Convenience type aliases
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

export type SmartsheetRowMap = Database['public']['Tables']['smartsheet_row_map']['Row']
export type SmartsheetWebhook = Database['public']['Tables']['smartsheet_webhooks']['Row']
export type SmartsheetPortfolio = Database['public']['Tables']['smartsheet_portfolio']['Row']
