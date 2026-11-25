/**
 * PDPL consent catalogue: purposes, current policy versions and what each app requires.
 * Mirrors private.consent_version() / private.required_consents() in
 * supabase/migrations/20261126000100_auth_privacy.sql (parity is tested).
 *
 * Bumping a version forces every user to re-confirm that purpose at next launch.
 */
import type { Bilingual } from '../core/types'

export type ConsentPurpose =
  | 'terms_of_service'
  | 'privacy_policy'
  | 'location_tracking'
  | 'regulatory_data_sharing'
  | 'marketing_communications'
  | 'analytics'

export type ConsentApp = 'rider' | 'driver'

export const CONSENT_PURPOSES: ConsentPurpose[] = [
  'terms_of_service',
  'privacy_policy',
  'location_tracking',
  'regulatory_data_sharing',
  'marketing_communications',
  'analytics',
]

export const CONSENT_VERSIONS: Record<ConsentPurpose, string> = {
  terms_of_service: '2026-11-26',
  privacy_policy: '2026-11-26',
  location_tracking: '2026-11-26',
  regulatory_data_sharing: '2026-11-26',
  marketing_communications: '2026-11-26',
  analytics: '2026-11-26',
}

export const REQUIRED_CONSENTS: Record<ConsentApp, ConsentPurpose[]> = {
  rider: ['terms_of_service', 'privacy_policy'],
  driver: ['terms_of_service', 'privacy_policy', 'location_tracking', 'regulatory_data_sharing'],
}

export const OPTIONAL_CONSENTS: ConsentPurpose[] = ['marketing_communications', 'analytics']

/** Which purposes are shown in each app (required first, then optional). */
export function purposesFor(app: ConsentApp): ConsentPurpose[] {
  return [...REQUIRED_CONSENTS[app], ...OPTIONAL_CONSENTS]
}

export type ConsentRecord = {
  purpose: ConsentPurpose
  granted: boolean
  policyVersion: string
  at: number
}

/** Latest decision per purpose (records may be in any order). */
export function latestConsents(records: ConsentRecord[]): Partial<Record<ConsentPurpose, ConsentRecord>> {
  const out: Partial<Record<ConsentPurpose, ConsentRecord>> = {}
  for (const r of records) {
    const cur = out[r.purpose]
    if (!cur || r.at >= cur.at) out[r.purpose] = r
  }
  return out
}

/** A purpose counts only if its latest record is a grant of the current version. */
export function isConsentCurrent(records: ConsentRecord[], purpose: ConsentPurpose): boolean {
  const last = latestConsents(records)[purpose]
  return !!last && last.granted && last.policyVersion === CONSENT_VERSIONS[purpose]
}

export function missingRequiredConsents(app: ConsentApp, records: ConsentRecord[]): ConsentPurpose[] {
  return REQUIRED_CONSENTS[app].filter((p) => !isConsentCurrent(records, p))
}

export const CONSENT_TEXT: Record<ConsentPurpose, { title: Bilingual; body: Bilingual; basis: Bilingual }> = {
  terms_of_service: {
    title: { ar: 'الشروط والأحكام', en: 'Terms of service' },
    body: {
      ar: 'اتفاقية استخدام خدمة أورا للتنقل، بما فيها الأجرة والإلغاء والسلوك.',
      en: 'The agreement for using AURA mobility, including fares, cancellations and conduct.',
    },
    basis: { ar: 'عقد', en: 'Contract' },
  },
  privacy_policy: {
    title: { ar: 'سياسة الخصوصية', en: 'Privacy policy' },
    body: {
      ar: 'نوضح فيها البيانات التي نجمعها (الاسم، الجوال، مواقع الرحلات، المدفوعات)، وسبب جمعها، ومدة الاحتفاظ بها، وحقوقك بموجب نظام حماية البيانات الشخصية.',
      en: 'What we collect (name, mobile, trip locations, payments), why, how long we keep it, and your rights under the Saudi PDPL.',
    },
    basis: { ar: 'إشعار', en: 'Notice' },
  },
  location_tracking: {
    title: { ar: 'تتبّع الموقع للكباتن', en: 'Captain location tracking' },
    body: {
      ar: 'نستخدم موقعك أثناء الاتصال وخلال الرحلات فقط، لإسناد الطلبات وتتبّع الرحلة وسلامة الراكب. يتوقف التتبّع عند قطع الاتصال.',
      en: 'Your location is used only while you are online and on trips, to dispatch requests, track the trip and keep riders safe. Tracking stops when you go offline.',
    },
    basis: { ar: 'موافقة', en: 'Consent' },
  },
  regulatory_data_sharing: {
    title: { ar: 'المشاركة النظامية مع هيئة النقل', en: 'Regulatory sharing with TGA' },
    body: {
      ar: 'نشارك بياناتك وبيانات مركبتك ورحلاتك مع الهيئة العامة للنقل عبر منصة وصل، وفق ما يتطلبه النظام.',
      en: 'Your identity, vehicle and trip data are shared with the Transport General Authority via Wasl, as required by regulation.',
    },
    basis: { ar: 'التزام نظامي', en: 'Legal obligation' },
  },
  marketing_communications: {
    title: { ar: 'العروض والرسائل التسويقية', en: 'Offers and marketing' },
    body: {
      ar: 'رسائل عن العروض والخصومات عبر الإشعارات والرسائل النصية. اختياري ويمكن إلغاؤه في أي وقت.',
      en: 'Offers and discounts by notification and SMS. Optional, and you can withdraw at any time.',
    },
    basis: { ar: 'موافقة اختيارية', en: 'Optional consent' },
  },
  analytics: {
    title: { ar: 'تحسين الخدمة والتحليلات', en: 'Service analytics' },
    body: {
      ar: 'بيانات استخدام مجمّعة لتحسين التطبيق. اختياري.',
      en: 'Aggregated usage data to improve the app. Optional.',
    },
    basis: { ar: 'موافقة اختيارية', en: 'Optional consent' },
  },
}

export type PrivacyRequestType = 'access' | 'correction' | 'deletion' | 'restriction' | 'objection'
export type PrivacyRequestStatus = 'pending' | 'in_progress' | 'completed' | 'rejected' | 'cancelled'

export type PrivacyRequest = {
  id: string
  number: number
  userId: string
  type: PrivacyRequestType
  status: PrivacyRequestStatus
  details?: string
  resolutionNote?: string
  createdAt: number
  dueAt: number
  completedAt?: number
}

/** PDPL: respond within 30 days. */
export const PRIVACY_RESPONSE_DAYS = 30

export const REQUEST_TYPE_LABEL: Record<PrivacyRequestType, Bilingual> = {
  access: { ar: 'نسخة من بياناتي', en: 'Copy of my data' },
  correction: { ar: 'تصحيح بيانات', en: 'Correct my data' },
  deletion: { ar: 'حذف الحساب والبيانات', en: 'Delete account and data' },
  restriction: { ar: 'تقييد المعالجة', en: 'Restrict processing' },
  objection: { ar: 'اعتراض على المعالجة', en: 'Object to processing' },
}

export const REQUEST_STATUS_LABEL: Record<PrivacyRequestStatus, Bilingual> = {
  pending: { ar: 'قيد الانتظار', en: 'Pending' },
  in_progress: { ar: 'قيد المعالجة', en: 'In progress' },
  completed: { ar: 'مكتمل', en: 'Completed' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
  cancelled: { ar: 'ملغى', en: 'Cancelled' },
}
