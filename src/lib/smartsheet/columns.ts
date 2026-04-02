// Column definitions for each Smartsheet sheet type

import { ColumnDefinition } from './types'

export const PROJECT_SHEET_COLUMNS: ColumnDefinition[] = [
  { title: 'Door Number', type: 'TEXT_NUMBER', primary: true },
  { title: 'HW Set', type: 'TEXT_NUMBER' },
  { title: 'HW Heading', type: 'TEXT_NUMBER' },
  { title: 'Location', type: 'TEXT_NUMBER' },
  { title: 'Door Type', type: 'TEXT_NUMBER' },
  { title: 'Frame Type', type: 'TEXT_NUMBER' },
  { title: 'Fire Rating', type: 'TEXT_NUMBER' },
  { title: 'Hand', type: 'TEXT_NUMBER' },
  { title: 'Classification', type: 'PICKLIST', options: ['Bench', 'Field', 'Mixed', 'Unclassified'] },
  { title: 'Received', type: 'TEXT_NUMBER' },
  { title: 'Pre-Install / Installed', type: 'TEXT_NUMBER' },
  { title: 'QA/QC', type: 'TEXT_NUMBER' },
  { title: 'Overall Status', type: 'PICKLIST', options: ['Not Started', 'In Progress', 'Complete'] },
  { title: 'Progress %', type: 'TEXT_NUMBER' },
  { title: 'Total Items', type: 'TEXT_NUMBER' },
  { title: 'App Link', type: 'TEXT_NUMBER' },
]

export const SUBMITTAL_SHEET_COLUMNS: ColumnDefinition[] = [
  { title: 'HW Set', type: 'TEXT_NUMBER', primary: true },
  { title: 'HW Heading', type: 'TEXT_NUMBER' },
  { title: 'Total Openings', type: 'TEXT_NUMBER' },
  { title: 'Hardware Summary', type: 'TEXT_NUMBER' },
  { title: 'Total Qty', type: 'TEXT_NUMBER' },
  { title: 'Submittal Status', type: 'PICKLIST', options: ['Not Submitted', 'Under Review', 'Approved', 'Approved As Noted', 'Revise & Resubmit'] },
  { title: 'Submittal Date', type: 'DATE' },
  { title: 'Approval Date', type: 'DATE' },
  { title: 'Lead Time (weeks)', type: 'TEXT_NUMBER' },
  { title: 'Expected Delivery', type: 'DATE' },
  { title: 'Notes', type: 'TEXT_NUMBER' },
]

export const DELIVERY_SHEET_COLUMNS: ColumnDefinition[] = [
  { title: 'PO Number', type: 'TEXT_NUMBER', primary: true },
  { title: 'Vendor', type: 'TEXT_NUMBER' },
  { title: 'Description', type: 'TEXT_NUMBER' },
  { title: 'Items', type: 'TEXT_NUMBER' },
  { title: 'Quantity', type: 'TEXT_NUMBER' },
  { title: 'Expected Date', type: 'DATE' },
  { title: 'Actual Date', type: 'DATE' },
  { title: 'Status', type: 'PICKLIST', options: ['Pending', 'In Transit', 'Delivered', 'Partial', 'Delayed', 'Cancelled'] },
  { title: 'Tracking Number', type: 'TEXT_NUMBER' },
  { title: 'Notes', type: 'TEXT_NUMBER' },
]

export const ISSUES_SHEET_COLUMNS: ColumnDefinition[] = [
  { title: 'Issue ID', type: 'TEXT_NUMBER', primary: true },
  { title: 'Door Number', type: 'TEXT_NUMBER' },
  { title: 'Hardware Item', type: 'TEXT_NUMBER' },
  { title: 'Description', type: 'TEXT_NUMBER' },
  { title: 'Severity', type: 'PICKLIST', options: ['Low', 'Medium', 'High', 'Critical'] },
  { title: 'Status', type: 'PICKLIST', options: ['Open', 'In Progress', 'Resolved', 'Closed'] },
  { title: 'Assigned To', type: 'TEXT_NUMBER' },
  { title: 'Reported By', type: 'TEXT_NUMBER' },
  { title: 'Date Reported', type: 'DATE' },
  { title: 'Date Resolved', type: 'DATE' },
  { title: 'Notes', type: 'TEXT_NUMBER' },
]

export const PORTFOLIO_SHEET_COLUMNS: ColumnDefinition[] = [
  { title: 'Project Name', type: 'TEXT_NUMBER', primary: true },
  { title: 'Job Number', type: 'TEXT_NUMBER' },
  { title: 'General Contractor', type: 'TEXT_NUMBER' },
  { title: 'Architect', type: 'TEXT_NUMBER' },
  { title: 'Total Openings', type: 'TEXT_NUMBER' },
  { title: 'Completion %', type: 'TEXT_NUMBER' },
  { title: 'Status', type: 'PICKLIST', options: ['Active', 'Completed', 'Archived'] },
  { title: 'Open Issues', type: 'TEXT_NUMBER' },
  { title: 'Pending Deliveries', type: 'TEXT_NUMBER' },
  { title: 'Last Synced', type: 'DATE' },
  { title: 'Sheet Link', type: 'TEXT_NUMBER' },
]
