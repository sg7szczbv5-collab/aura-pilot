/**
 * Legal and safety documents shown in the apps (Arabic + English).
 *
 * STATUS: DRAFTS prepared for legal review — not legal advice. Items in
 * [brackets] must be completed by AURA's legal team (entity, CR number,
 * addresses, DPO contact, final fees and timelines) before launch.
 * Versions are tied to the consent versions: changing a document's version
 * here and in private.consent_version() makes users accept it again.
 */
import type { Bilingual } from '../core/types'
import { CONSENT_VERSIONS } from '../privacy/consents'

export type LegalDocId = 'terms' | 'privacy' | 'captain' | 'safety'
export type LegalSection = { heading: Bilingual; body: Bilingual[] }
export type LegalDoc = { id: LegalDocId; version: string; draft: boolean; title: Bilingual; summary: Bilingual; sections: LegalSection[] }

const b = (ar: string, en: string): Bilingual => ({ ar, en })

export const LEGAL_DOCS: Record<LegalDocId, LegalDoc> = {
  terms: {
    id: 'terms',
    version: CONSENT_VERSIONS.terms_of_service,
    draft: true,
    title: b('الشروط والأحكام', 'Terms of Service'),
    summary: b('اتفاقية استخدام تطبيق أورا لطلب الرحلات.', 'The agreement for using the AURA ride app.'),
    sections: [
      {
        heading: b('١. الخدمة', '1. The service'),
        body: [
          b(
            'أورا منصة تقنية مرخّصة من الهيئة العامة للنقل [رقم الترخيص] تربط الركاب بكباتن مستقلين مسجلين ومؤهلين عبر منصة وصل. يقدّم خدمة النقل الكابتن، وتدير أورا الطلب والتسعير والدفع والدعم.',
            'AURA is a technology platform licensed by the Transport General Authority [licence no.] that connects riders with independent captains who are registered and eligible on Wasl. The captain provides the transport; AURA handles booking, pricing, payment and support.',
          ),
          b('المشغّل: [الاسم القانوني للشركة، رقم السجل التجاري، العنوان الوطني].', 'Operator: [legal entity name, commercial registration number, national address].'),
        ],
      },
      {
        heading: b('٢. الحساب', '2. Your account'),
        body: [
          b('يُشترط أن يكون عمرك ١٨ عاماً فأكثر وأن تسجّل برقم جوال سعودي تتحقق منه برمز. أنت مسؤول عن سرية جهازك وحسابك.', 'You must be 18 or older and register with a Saudi mobile number verified by code. You are responsible for keeping your device and account secure.'),
          b('يجوز لنا إيقاف الحساب عند إساءة الاستخدام أو الاحتيال أو مخالفة هذه الشروط، مع إشعارك بالسبب ما لم يمنع ذلك نظام.', 'We may suspend an account for misuse, fraud or breach of these terms, and will tell you why unless the law prevents it.'),
        ],
      },
      {
        heading: b('٣. الأجرة والدفع', '3. Fares and payment'),
        body: [
          b('يظهر لك سعر الرحلة قبل التأكيد ويشمل ضريبة القيمة المضافة ١٥٪. السعر المعروض عند الطلب هو السعر المستحق ما لم تغيّر الوجهة أو تطلب توقفات إضافية.', 'You see the fare before you confirm, including 15% VAT. The price shown when you request is what you pay unless you change the destination or add stops.'),
          b('الدفع بالبطاقة (مدى/فيزا/ماستركارد/Apple Pay) عبر بوابة دفع مرخّصة، أو من محفظة أورا، أو نقداً للكابتن. في الدفع بالبطاقة نحجز مبلغ الرحلة عند الطلب ونخصمه عند انتهائها ونلغي الحجز إن أُلغيت.', 'Pay by card (mada/Visa/Mastercard/Apple Pay) through a licensed payment gateway, from your AURA Wallet, or in cash to the captain. For card payments we authorize the fare when you request, capture it when the trip ends, and release it if the trip is cancelled.'),
          b('الإكرامية اختيارية وتذهب كاملة للكابتن.', 'Tips are optional and go entirely to the captain.'),
        ],
      },
      {
        heading: b('٤. الإلغاء والاسترداد', '4. Cancellations and refunds'),
        body: [
          b('يمكنك الإلغاء قبل بدء الرحلة. قد تُطبَّق رسوم إلغاء [تُحدَّد] إذا وصل الكابتن وانتظر. تُراجَع طلبات الاسترداد عبر الدعم وتُعاد إلى وسيلة الدفع الأصلية أو المحفظة.', 'You can cancel before the trip starts. A cancellation fee [to be set] may apply after the captain has arrived and waited. Refund requests are reviewed by support and returned to the original payment method or the wallet.'),
        ],
      },
      {
        heading: b('٥. السلوك والسلامة', '5. Conduct and safety'),
        body: [
          b('يُمنع أي سلوك مسيء أو تمييزي أو غير نظامي. تحقّق من لوحة السيارة واسم الكابتن، ولا تشارك رمز الرحلة إلا داخل السيارة. استخدم زر الطوارئ عند الحاجة.', 'Abusive, discriminatory or unlawful behaviour is not allowed. Check the plate and captain name, and share your trip code only inside the car. Use the emergency button when needed.'),
        ],
      },
      {
        heading: b('٦. المسؤولية', '6. Liability'),
        body: [
          b('لا تحدّ هذه الشروط من حقوقك النظامية كمستهلك. [تُستكمل حدود المسؤولية والتأمين من الفريق القانوني].', 'Nothing here limits your statutory consumer rights. [Liability limits and insurance to be completed by legal.]'),
        ],
      },
      {
        heading: b('٧. النظام الحاكم والتعديلات', '7. Governing law and changes'),
        body: [
          b('تخضع هذه الشروط لأنظمة المملكة العربية السعودية. سنُبلغك بأي تعديل جوهري ونطلب موافقتك من جديد قبل سريانه.', 'These terms are governed by the laws of the Kingdom of Saudi Arabia. We will notify you of material changes and ask you to accept again before they apply.'),
          b('التواصل والشكاوى: من داخل التطبيق ← المساعدة، أو [عنوان التواصل الرسمي].', 'Contact and complaints: in the app under Help, or [official contact address].'),
        ],
      },
    ],
  },

  privacy: {
    id: 'privacy',
    version: CONSENT_VERSIONS.privacy_policy,
    draft: true,
    title: b('سياسة الخصوصية', 'Privacy Policy'),
    summary: b('كيف نجمع بياناتك ونستخدمها ونحميها وفق نظام حماية البيانات الشخصية.', 'How we collect, use and protect your data under the Personal Data Protection Law (PDPL).'),
    sections: [
      {
        heading: b('١. جهة التحكم', '1. Controller'),
        body: [b('[الاسم القانوني لأورا والسجل التجاري]. مسؤول حماية البيانات: [الاسم وطريقة التواصل].', "[AURA's legal entity and CR number]. Data protection officer: [name and contact].")],
      },
      {
        heading: b('٢. البيانات التي نجمعها', '2. Data we collect'),
        body: [
          b('الحساب: الاسم، رقم الجوال، البريد (اختياري). الرحلات: نقاط الانطلاق والوصول، الأوقات، الأجرة، التقييمات. الدفع: آخر ٤ أرقام ونوع البطاقة ورمز البوابة (لا نخزّن رقم البطاقة). الدعم: محادثاتك معنا.', 'Account: name, mobile number, email (optional). Trips: pickup and drop-off points, times, fares, ratings. Payments: card type, last 4 digits and a gateway token (we never store card numbers). Support: your conversations with us.'),
          b('للكباتن أيضاً: رقم الهوية/الإقامة، تاريخ الميلاد، الآيبان، الرخصة، بيانات المركبة ووثائقها، والموقع أثناء الاتصال فقط.', 'For captains also: national ID/Iqama, date of birth, IBAN, licence, vehicle details and documents, and location while online only.'),
        ],
      },
      {
        heading: b('٣. الأغراض والأساس النظامي', '3. Purposes and legal basis'),
        body: [
          b('تقديم الخدمة وتنفيذ العقد (الحجز، الإسناد، التتبّع، الدفع). الالتزامات النظامية (مشاركة بيانات الكباتن والمركبات والرحلات مع الهيئة العامة للنقل عبر وصل، الفوترة الضريبية). الموافقة (العروض التسويقية، التحليلات، تتبّع موقع الكابتن). المصلحة المشروعة (منع الاحتيال والسلامة).', 'Providing the service under contract (booking, dispatch, tracking, payment). Legal obligations (sharing captain, vehicle and trip data with the Transport General Authority via Wasl; tax invoicing). Consent (marketing, analytics, captain location tracking). Legitimate interest (fraud prevention and safety).'),
        ],
      },
      {
        heading: b('٤. المشاركة', '4. Sharing'),
        body: [
          b('مع الكابتن/الراكب بقدر ما تتطلبه الرحلة (الاسم الأول، التقييم، المركبة، الموقع أثناء الرحلة). مع الهيئة العامة للنقل (وصل). مع بوابة الدفع (ميسّر) ومزوّدي الخرائط (Google) والاستضافة (Supabase) بموجب عقود تحمي بياناتك. لا نبيع بياناتك.', 'With the captain/rider as needed for the trip (first name, rating, vehicle, location during the trip). With the Transport General Authority (Wasl). With the payment gateway (Moyasar), maps provider (Google) and hosting (Supabase) under contracts that protect your data. We do not sell your data.'),
          b('نقل البيانات خارج المملكة يتم فقط وفق ضوابط النظام ولائحته التنفيذية. [يُستكمل: مواقع الاستضافة والضمانات].', 'Transfers outside the Kingdom happen only under the PDPL and its regulations. [To complete: hosting locations and safeguards.]'),
        ],
      },
      {
        heading: b('٥. مدة الاحتفاظ', '5. Retention'),
        body: [
          b('مسار الرحلة التفصيلي (نقاط GPS): ١٨٠ يوماً. حمولات الإرسال إلى وصل: سنة ثم تُحذف. سجلات الرحلات والفواتير والقيود المالية: طوال المدة النظامية المطلوبة [تُحدَّد]. روابط مشاركة الرحلة: تنتهي خلال ١٢ ساعة وتُحذف بعد ٣٠ يوماً.', 'Detailed trip paths (GPS points): 180 days. Payloads sent to Wasl: one year, then deleted. Trip records, invoices and financial entries: for the legally required period [to be set]. Trip share links: expire within 12 hours and are deleted after 30 days.'),
        ],
      },
      {
        heading: b('٦. حقوقك', '6. Your rights'),
        body: [
          b('من حسابي ← الخصوصية والبيانات يمكنك: تنزيل نسخة من بياناتك فوراً، وطلب التصحيح أو التقييد أو الاعتراض أو الحذف، وسحب أي موافقة. نرد على الطلبات خلال ٣٠ يوماً. عند الحذف نُبقي فقط ما يُلزمنا النظام بحفظه، بصورة مجهولة.', 'In Account → Privacy & data you can: download a copy of your data instantly, request correction, restriction, objection or deletion, and withdraw any consent. We answer requests within 30 days. On deletion we keep only what the law requires, in anonymised form.'),
          b('يحق لك تقديم شكوى إلى الهيئة السعودية للبيانات والذكاء الاصطناعي (سدايا).', 'You may lodge a complaint with the Saudi Data & AI Authority (SDAIA).'),
        ],
      },
      {
        heading: b('٧. الأمان', '7. Security'),
        body: [b('تشفير الاتصال، صلاحيات دقيقة على مستوى كل سجل، تحقق ثنائي إلزامي لموظفينا، وسجل تدقيق لكل إجراء إداري.', 'Encrypted connections, per-record access control, mandatory two-factor authentication for staff, and an audit log of every administrative action.')],
      },
    ],
  },

  captain: {
    id: 'captain',
    version: CONSENT_VERSIONS.regulatory_data_sharing,
    draft: true,
    title: b('اتفاقية الكابتن', 'Captain Agreement'),
    summary: b('شروط العمل ككابتن مستقل على منصة أورا.', 'Terms for working as an independent captain on AURA.'),
    sections: [
      {
        heading: b('١. الأهلية والوثائق', '1. Eligibility and documents'),
        body: [
          b('هوية وطنية أو إقامة سارية، رخصة قيادة سارية، عمر ١٨ عاماً فأكثر، مركبة بعمر لا يتجاوز [الحد النظامي] مع استمارة وتأمين ساريين، وأهلية على منصة وصل.', 'A valid national ID or Iqama, a valid driving licence, age 18+, a vehicle within [the regulatory age limit] with valid registration and insurance, and eligibility on Wasl.'),
          b('عند انتهاء أي وثيقة يتوقف استقبال الطلبات تلقائياً حتى تحديثها.', 'When any document expires, trip offers stop automatically until it is renewed.'),
        ],
      },
      {
        heading: b('٢. منصة وصل والهيئة العامة للنقل', '2. Wasl and the Transport General Authority'),
        body: [
          b('نسجّل بياناتك وبيانات مركبتك ورحلاتك لدى الهيئة عبر وصل كما يتطلب النظام، ونعيد التحقق من أهليتك دورياً. إذا أفادت وصل بعدم الأهلية يُعلَّق الحساب.', 'We register your details, your vehicle and your trips with the Authority via Wasl as required, and re-check eligibility regularly. If Wasl reports you as ineligible, the account is suspended.'),
        ],
      },
      {
        heading: b('٣. الموقع', '3. Location'),
        body: [b('يُجمع موقعك فقط أثناء الاتصال وخلال الرحلات للإسناد والتتبّع والسلامة، ويتوقف عند قطع الاتصال.', 'Your location is collected only while online and during trips, for dispatch, tracking and safety, and stops when you go offline.')],
      },
      {
        heading: b('٤. الأرباح والعمولة والتسوية', '4. Earnings, commission and settlement'),
        body: [
          b('تحصل على أجرة الرحلة ناقص عمولة أورا [النسبة حسب الفئة]، والإكراميات كاملة. في الرحلات النقدية تُستحق العمولة والضريبة لأورا وتُسوّى من رصيدك أو بإيداع.', 'You earn the trip fare minus AURA’s commission [rate per class], plus all tips. On cash trips the commission and VAT are owed to AURA and settled from your balance or by deposit.'),
          b('تُحوَّل الأرصدة إلى الآيبان المسجّل أسبوعياً متى بلغت الحد الأدنى، أو عند الطلب.', 'Balances are transferred to your registered IBAN weekly once they reach the minimum, or on request.'),
        ],
      },
      {
        heading: b('٥. السلوك والإيقاف', '5. Conduct and deactivation'),
        body: [b('الالتزام بأنظمة المرور وآداب الخدمة والتحقق من رمز الراكب قبل البدء. نوقف الحساب عند مخالفات السلامة أو الاحتيال أو انتهاء الأهلية، مع إبلاغك وحقك في الاعتراض.', 'Follow traffic law and service standards, and verify the rider’s code before starting. We deactivate accounts for safety violations, fraud or loss of eligibility, with notice and a right to appeal.')],
      },
    ],
  },

  safety: {
    id: 'safety',
    version: CONSENT_VERSIONS.terms_of_service,
    draft: true,
    title: b('إرشادات السلامة', 'Safety guidelines'),
    summary: b('ما نفعله وما يمكنك فعله لرحلة آمنة.', 'What we do, and what you can do, for a safe trip.'),
    sections: [
      {
        heading: b('قبل الرحلة', 'Before the trip'),
        body: [b('طابق لوحة السيارة ونوعها واسم الكابتن مع التطبيق. لا تركب إن لم تتطابق.', 'Match the plate, car and captain name with the app. Do not get in if they do not match.'), b('اذكر رمز الرحلة داخل السيارة فقط؛ لا تبدأ الرحلة بدونه.', 'Say your trip code only once inside the car; the trip cannot start without it.')],
      },
      {
        heading: b('أثناء الرحلة', 'During the trip'),
        body: [
          b('شارك رحلتك مباشرة مع من تثق به من زر المشاركة؛ ينتهي الرابط تلقائياً بعد الرحلة.', 'Share your live trip with someone you trust using Share; the link expires after the trip.'),
          b('زر الطوارئ يتصل بـ ٩١١ وينبّه فريق السلامة في أورا بموقعك فوراً.', 'The emergency button calls 911 and alerts AURA’s safety team with your location immediately.'),
          b('اربط حزام الأمان دائماً.', 'Always wear your seat belt.'),
        ],
      },
      {
        heading: b('بعد الرحلة', 'After the trip'),
        body: [b('أبلغ عن أي سلوك غير لائق أو قيادة خطرة من الإيصال أو المساعدة؛ تُعامَل بلاغات السلامة بأولوية عاجلة.', 'Report inappropriate behaviour or unsafe driving from the receipt or Help; safety reports are handled as urgent.')],
      },
    ],
  },
}

/** Which full document explains each consent purpose. */
export const DOC_FOR_PURPOSE = {
  terms_of_service: 'terms',
  privacy_policy: 'privacy',
  location_tracking: 'captain',
  regulatory_data_sharing: 'captain',
  marketing_communications: 'privacy',
  analytics: 'privacy',
} as const satisfies Record<keyof typeof CONSENT_VERSIONS, LegalDocId>
