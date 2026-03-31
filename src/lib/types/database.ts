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
        }
      }
      project_members: {
        Row: {
          id: string
          project_id: string
          user_id: string
          role: 'owner' | 'admin' | 'member'
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          user_id: string
          role?: 'owner' | 'admin' | 'member'
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          user_id?: string
          role?: 'owner' | 'admin' | 'member'
          created_at?: string
        }
      }
      openings: {
        Row: {
          id: string
          project_id: string
          door_number: string
          hw_set: string | null
          hw_heading: string | null
          fire_rating: string | null
          door_type: string | null
          frame_type: string | null
          location: string | null
          status: 'not_started' | 'in_progress' | 'installed' | 'inspected' | 'issue'
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          project_id: string
          door_number: string
          hw_set?: string | null
          hw_heading?: string | null
          fire_rating?: string | null
          door_type?: string | null
          frame_type?: string | null
          location?: string | null
          status?: 'not_started' | 'in_progress' | 'installed' | 'inspected' | 'issue'
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          door_number?: string
          hw_set?: string | null
          hw_heading?: string | null
          fire_rating?: string | null
          door_type?: string | null
          frame_type?: string | null
          location?: string | null
          status?: 'not_started' | 'in_progress' | 'installed' | 'inspected' | 'issue'
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      hardware_items: {
        Row: {
          id: string
          opening_id: string
          name: string
          category: string
          quantity: number
          specification: string | null
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          opening_id: string
          name: string
          category: string
          quantity: number
          specification?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          opening_id?: string
          name?: string
          category?: string
          quantity?: number
          specification?: string | null
          notes?: string | null
          created_at?: string
          updated_at?: string
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
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          opening_id: string
          item_id: string
          checked?: boolean
          checked_by?: string | null
          checked_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          opening_id?: string
          item_id?: string
          checked?: boolean
          checked_by?: string | null
          checked_at?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      attachments: {
        Row: {
          id: string
          opening_id: string
          file_name: string
          file_url: string
          file_type: string
          file_size: number
          uploaded_by: string
          created_at: string
        }
        Insert: {
          id?: string
          opening_id: string
          file_name: string
          file_url: string
          file_type: string
          file_size: number
          uploaded_by: string
          created_at?: string
        }
        Update: {
          id?: string
          opening_id?: string
          file_name?: string
          file_url?: string
          file_type?: string
          file_size?: number
          uploaded_by?: string
          created_at?: string
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
