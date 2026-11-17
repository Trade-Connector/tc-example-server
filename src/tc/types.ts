// Types for the Trade Connector Partner API v1, written from the API's real behaviour.
//
// Statuses and event types are open-ended on purpose: TC may add values, so every union below
// also accepts any other string. Code that switches on them should have a default branch.

/** Every job status TC uses today. The published OpenAPI list is wrong here: it has EXPIRED
 * (never used) and lacks PENDING_CUSTOMER_SIG. */
export const KNOWN_JOB_STATUSES = [
  "DRAFT", // saved, not sent to installers
  "OPEN", // live, finding an installer
  "OFFERED", // offered to one installer, awaiting acceptance
  "ASSIGNED", // an installer accepted
  "SCHEDULED", // a date is booked
  "IN_PROGRESS", // work started on site
  "WORK_COMPLETE", // finished, evidence uploaded
  "PENDING_CUSTOMER_SIG", // awaiting the end customer's sign-off
  "PAID", // settled
  "CANCELLED",
  "DISPUTED",
] as const;

export type KnownJobStatus = (typeof KNOWN_JOB_STATUSES)[number];
/** A job status. Unknown future values are still strings, so handle them gracefully. */
export type JobStatus = KnownJobStatus | (string & {});

export function isKnownJobStatus(value: unknown): value is KnownJobStatus {
  return typeof value === "string" && (KNOWN_JOB_STATUSES as readonly string[]).includes(value);
}

/** A job can be changed with PATCH only in these statuses. Otherwise TC answers 409 JOB_LOCKED. */
export const EDITABLE_STATUSES: readonly KnownJobStatus[] = ["DRAFT", "OPEN"];

/** The cancel endpoint refuses these with 409 JOB_LOCKED. */
export const NOT_CANCELLABLE_STATUSES: readonly KnownJobStatus[] = [
  "WORK_COMPLETE",
  "PAID",
  "CANCELLED",
  "DISPUTED",
];

/** Attachments are refused (409 JOB_LOCKED) on jobs in these statuses. */
export const NO_ATTACHMENT_STATUSES: readonly KnownJobStatus[] = ["CANCELLED", "PAID"];

/** Targets accepted by the sandbox simulate endpoint, in lifecycle order (CANCELLED aside). */
export const SIMULATE_TARGETS = [
  "OPEN",
  "ASSIGNED",
  "SCHEDULED",
  "IN_PROGRESS",
  "WORK_COMPLETE",
  "PAID",
  "CANCELLED",
] as const;
export type SimulateTarget = (typeof SIMULATE_TARGETS)[number];

export type StateTerritory = "NSW" | "VIC" | "QLD" | "SA" | "WA" | "TAS" | "NT" | "ACT";
export type Urgency = "LOW" | "NORMAL" | "HIGH" | "URGENT" | "EMERGENCY";
export type ContactRole = "SITE_OWNER" | "PROPERTY_MANAGER" | "TENANT" | "OTHER";
export type AttachmentCategory =
  | "SITE_PHOTO"
  | "SPEC_SHEET"
  | "PLAN"
  | "PERMIT"
  | "CONTRACT"
  | "INVOICE"
  | "COMPLIANCE"
  | "OTHER";

export const ATTACHMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Job object (returned by every job route and carried inside every webhook as data.job)
// ---------------------------------------------------------------------------------------------

export interface JobSite {
  address: string;
  unit: string | null;
  suburb: string;
  state: StateTerritory;
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  access_instructions: string | null;
}

export interface JobSchedule {
  preferred_start_date: string | null; // YYYY-MM-DD
  preferred_end_date: string | null; // YYYY-MM-DD
  /** MORNING | AFTERNOON | FULL_DAY, "HH:MM-HH:MM" or "HH:MM", site local time. */
  time_window: string | null;
  estimated_hours: number | null;
  /** Set by TC when a date is booked. */
  scheduled_date: string | null;
}

export interface JobContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: ContactRole | (string & {});
  is_primary: boolean;
}

/** Money is integer cents, AUD. */
export interface JobPrice {
  currency: "AUD";
  price_source: string | null;
  ex_gst_cents: number | null;
  gst_cents: number | null;
  inc_gst_cents: number | null;
  subtotal_cents: number | null;
  total_cents: number | null;
  /** Optional upper budget (ex GST). Null when the job has none. */
  upper_ex_gst_cents: number | null;
  upper_inc_gst_cents: number | null;
  /** When the job is due to be listed at the upper budget. Always null for sandbox jobs. */
  upper_reprice_at: string | null;
}

export interface InstallerAccreditation {
  name: string;
  issuing_body: string | null;
  number: string | null;
  expiry: string | null;
}

export interface Job {
  id: string;
  customer_id: string;
  external_reference: string | null;
  status: JobStatus;
  is_sandbox: boolean;
  creation_pathway: string | null;
  title: string;
  description: string;
  notes: string | null;
  job_type_id: number | null;
  urgency: Urgency;
  urgency_level: number;
  trade_codes: string[];
  accreditation_ids: string[];
  site: JobSite;
  schedule: JobSchedule;
  end_customer: { name: string | null; email: string | null; phone: string | null } | null;
  contacts: JobContact[];
  price: JobPrice;
  /** The installer company once one is assigned. No contact details are ever shared. */
  assigned_installer: { company_name: string; accreditations: InstallerAccreditation[] } | null;
  /** True only on a create that was replayed from an Idempotency-Key. Absent in webhooks. */
  replayed?: boolean;
  /** Only in webhooks: your label for the status, from the endpoint's status mapping. */
  client_status_label?: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  work_completed_at: string | null;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export interface SiteInput {
  address: string;
  unit?: string | null;
  suburb: string;
  state: StateTerritory;
  postcode: string; // 4 digits
  latitude?: number | null;
  longitude?: number | null;
  access_instructions?: string | null;
}

export interface ScheduleInput {
  preferred_start_date?: string | null;
  preferred_end_date?: string | null;
  time_window?: string | null;
  estimated_hours?: number | null;
}

export interface ContactInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  role?: ContactRole;
}

export interface PriceInput {
  /** Your price ex GST, integer cents. TC adds GST at 10%. */
  ex_gst_cents: number;
  /** Optional upper budget ex GST, greater than ex_gst_cents. null removes it on update. */
  upper_ex_gst_cents?: number | null;
}

/** POST /v1/jobs. Unknown fields are rejected with VALIDATION_ERROR. */
export interface CreateJobRequest {
  title: string;
  description: string;
  site: SiteInput;
  job_type_id?: number | null;
  /** 1-20 codes from /v1/reference/trade-types. The first is the primary trade. */
  trade_codes?: string[];
  accreditation_ids?: string[];
  schedule?: ScheduleInput | null;
  urgency?: Urgency | 1 | 2 | 3 | 4 | 5;
  end_customer?: { name?: string | null; email?: string | null; phone?: string | null } | null;
  /** Up to 20. The first is the primary contact. */
  contacts?: ContactInput[];
  /** Your own job number. Unique per environment, and cannot be changed once set. */
  external_reference?: string | null;
  /** false (default) creates a DRAFT; true creates it OPEN, live to installers. */
  publish?: boolean;
  price?: PriceInput | null;
  notes?: string | null;
}

/** PATCH /v1/jobs/{id}. Only while DRAFT or OPEN. Every field optional. */
export interface UpdateJobRequest {
  title?: string;
  description?: string;
  job_type_id?: number | null;
  trade_codes?: string[];
  accreditation_ids?: string[] | null;
  site?: Partial<SiteInput>;
  /** null clears the schedule. */
  schedule?: ScheduleInput | null;
  urgency?: Urgency | 1 | 2 | 3 | 4 | 5;
  end_customer?: { name?: string | null; email?: string | null; phone?: string | null } | null;
  /** Replaces the whole list; null clears it. */
  contacts?: ContactInput[] | null;
  /** Only accepted while the job has none. Sending it when one is set is refused, even the same value. */
  external_reference?: string | null;
  /** true moves DRAFT to OPEN. A job cannot be unpublished. */
  publish?: boolean;
  /** Must always include ex_gst_cents. */
  price?: PriceInput;
  notes?: string | null;
}

export interface ListJobsQuery {
  /** One status or several, comma-separated. */
  status?: string | string[];
  external_reference?: string;
  /** ISO 8601, inclusive. Use it to sync changes. */
  updated_since?: string;
  cursor?: string;
  /** 1-100, default 20. */
  limit?: number;
}

/** A page of a keyset-paginated list, ordered by updated_at descending. */
export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface CancelJobResponse {
  success: true;
  job_id: string;
  status: "CANCELLED";
  previous_status: string;
  cancelled_by_role: "CLIENT";
  fee_applied: boolean;
  fee_amount_cents: number;
  gst_cents: number;
  /** CLEAN, LATE_CANCEL or NO_SHOW. */
  cancellation_type: string;
  trade_notified: boolean;
  payment_cancelled: boolean;
  charge_status: "PAID" | "INVOICED" | "RECONCILE_REQUIRED" | "NONE";
  invoice_number: string | null;
  card_last4: string | null;
  decline_reason: string | null;
  message: string;
}

export interface JobNote {
  id: string;
  audit_log_id: number;
  /** Set when the note was also sent to the assigned installer as a chat message. */
  message_id: string | null;
  job_id: string;
  body: string;
  note: string;
  author_user_id: string | null;
  author_source: "partner_api";
  created_at: string;
}

export interface CreateAttachmentRequest {
  filename: string; // no path separators or ".."
  content_type: AttachmentContentType;
  size_bytes: number; // 1 .. 25 MB
  category?: AttachmentCategory;
  title?: string;
}

export interface AttachmentUpload {
  attachment_id: string;
  job_id: string;
  bucket: "job-documents";
  storage_path: string;
  /** Signed URL: PUT the file bytes here within expires_in seconds. */
  upload_url: string;
  token: string;
  expires_in: number;
  filename: string;
  content_type: AttachmentContentType;
  size_bytes: number;
}

export interface CompleteAttachmentRequest {
  /** Same values as step 1. */
  filename: string;
  content_type: AttachmentContentType;
  size_bytes: number;
  storage_path?: string;
  category?: AttachmentCategory;
  title?: string;
  is_public?: boolean;
}

export interface AttachmentRecord {
  id: string;
  job_id: string;
  filename: string;
  file_name: string;
  mime_type: string | null;
  file_type: string | null;
  file_size: number | null;
  category: string | null;
  storage_path: string;
  is_public: boolean;
  created_at: string;
}

export interface JobType {
  id: number;
  name: string;
  service_category_id: number | null;
  description: string | null;
}
export interface TradeType {
  code: string;
  name: string;
  category: string | null;
}
export interface Accreditation {
  id: string;
  name: string;
  category: string | null;
  issuing_body: string | null;
  type: string | null;
  scope: string | null;
}

// ---------------------------------------------------------------------------------------------
// Installs (manufacturers only, production keys only)
// ---------------------------------------------------------------------------------------------

export type InstallStatus =
  | "REGISTERED"
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "REJECTED"
  | "REPLACED"
  | (string & {});

export interface UpsertInstallRequest {
  serial_number: string;
  model?: string | null;
  installed_on?: string | null;
  shipped_on?: string | null;
  installer_name?: string | null;
  installer_abn?: string | null;
  installer_phone?: string | null;
  installer_email?: string | null;
  site_address?: string | null;
  site_suburb?: string | null;
  site_state?: string | null;
  site_postcode?: string | null;
  homeowner_name?: string | null;
  homeowner_email?: string | null;
  homeowner_phone?: string | null;
  external_reference?: string | null;
}

export interface ListInstallsQuery {
  serial?: string;
  /** One status or several, comma-separated. */
  status?: string;
  updated_since?: string;
  cursor?: string;
  limit?: number;
}

/** An install registration with its computed warranty coverage. Kept loose on purpose. */
export interface InstallRegistration {
  id: string;
  serial_number: string;
  status: InstallStatus;
  created_at: string;
  updated_at: string;
  coverage: Array<Record<string, unknown>>;
  [field: string]: unknown;
}

export interface HealthResponse {
  status: "ok";
  version: "v1";
}
