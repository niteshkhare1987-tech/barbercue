import type { Metadata } from "next";
import Link from "next/link";
import { CustomerShell } from "../../../components/layout/CustomerShell";
import { absoluteUrl } from "../../../lib/seo";
import styles from "./privacy-policy.module.css";

const TITLE = "Privacy Policy";
const DESCRIPTION = "How FastQue handles account, booking, location, image, payment-routing and notification data.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl("/privacy-policy") },
  openGraph: {
    title: `${TITLE} | FastQue`,
    description: DESCRIPTION,
    url: absoluteUrl("/privacy-policy"),
    type: "website",
  },
};

export default function PrivacyPolicyPage() {
  return (
    <CustomerShell>
      <main className={styles.page}>
        <article className={styles.article}>
          <header className={styles.hero}>
            <p className={styles.eyebrow}>FastQue legal information</p>
            <h1>Privacy Policy</h1>
            <p className={styles.updated}>Last updated: September 10, 2026</p>
            <p className={styles.lead}>
              This policy explains how FastQue handles information when you use the FastQue mobile app and fastque.com.
              FastQue helps customers discover salons, book appointments and follow participating live queues, while
              helping salons manage their services, staff, bookings and queue operations.
            </p>
          </header>

          <nav className={styles.contents} aria-label="Privacy policy sections">
            <a href="#data">Information FastQue handles</a>
            <a href="#use">How FastQue uses it</a>
            <a href="#sharing">Services involved</a>
            <a href="#advertising">Advertising choices</a>
            <a href="#retention">Retention and deletion</a>
            <a href="#contact">Contact us</a>
            <a href="#security">Security</a>
          </nav>

          <section id="advertising">
            <h2>Optional advertising measurement</h2>
            <p>
              When you allow advertising measurement on fastque.com, FastQue uses Meta Pixel to share
              activity such as page views, searches, salon views and confirmed bookings with Meta.
              Meta receives browser and network information when the Pixel runs.
              Use Advertising choices to decline or withdraw your permission at any time.
              FastQue also honors the Global Privacy Control browser signal for this measurement.
            </p>
          </section>

          <section id="data">
            <h2>Information FastQue handles</h2>
            <div className={styles.stack}>
              <section>
                <h3>Account and sign-in information</h3>
                <p>
                  FastQue may handle your email address, phone number, account role, language preference and session
                  information when you sign in or use a FastQue account. Customers can use phone verification or Google
                  sign-in. Salon owners and staff can use their eligible FastQue account credentials or Google sign-in.
                </p>
              </section>
              <section>
                <h3>Location information</h3>
                <p>
                  The mobile app requests foreground precise location only when you choose a location-based feature,
                  such as nearby discovery or using the current location while registering a shop. Nearby-search
                  coordinates are sent with that search. FastQue does not request background location through these
                  features.
                </p>
              </section>
              <section>
                <h3>Booking, queue and salon information</h3>
                <p>
                  FastQue handles the information needed to operate bookings and live queues, including selected salon,
                  service, staff preference, appointment time, booking status, cancellation or reschedule information,
                  queue position and applicable amount. Salon operators may provide shop profile details, services,
                  working hours, staff details and chair information.
                </p>
              </section>
              <section>
                <h3>Payment-routing and promotional-credit information</h3>
                <p>
                  A salon may upload a payment QR image and, when FastQue can safely read a valid UPI payment QR, the
                  associated UPI ID and payee name. After a booking is created, FastQue can present the server-calculated
                  payable amount, the salon QR and a generic UPI payment intent. FastQue Credits are promotional credits
                  recorded against an account and may affect the final amount returned by the booking service.
                </p>
                <p>
                  FastQue is not a payment gateway. Opening a UPI app, scanning a QR or returning to FastQue does not
                  make FastQue mark a payment as paid or verify settlement.
                </p>
              </section>
              <section>
                <h3>Photos and content you choose to provide</h3>
                <p>
                  Salon operators can upload or link salon cover, gallery and payment-QR images. Customers who submit a
                  review may provide a rating and optional review text; review text can appear on the relevant public
                  salon profile, without a customer display name. Owners can add a response to a review.
                </p>
                <p>
                  The optional Style Advisor lets a customer choose an image to request hairstyle previews. The current
                  FastQue implementation processes that image in memory and does not store the original Style Advisor
                  image. The image-generation provider is not enabled by default; FastQue will update this policy before
                  enabling a third-party image-generation provider for that feature.
                </p>
              </section>
              <section>
                <h3>Notification information</h3>
                <p>
                  If an eligible salon owner or staff member grants notification permission, FastQue can register an Expo
                  push token and notification preferences to deliver booking and operational updates. Notification
                  content is designed to avoid unnecessary customer contact details.
                </p>
              </section>
            </div>
          </section>

          <section id="use">
            <h2>How FastQue uses information</h2>
            <ul>
              <li>Authenticate users, protect sessions and apply role-based access controls.</li>
              <li>Show salons, services, availability, booking details and live-queue updates.</li>
              <li>Operate booking creation, cancellation, rescheduling, payment-routing display and promotional-credit redemption.</li>
              <li>Let salon operators manage their shop profile, photos, payment QR, staff, chairs, services and operations.</li>
              <li>Send requested or enabled in-app and device notifications.</li>
              <li>Prevent abuse, diagnose service failures and maintain audit records for authorised operational actions.</li>
            </ul>
          </section>

          <section id="sharing">
            <h2>Services involved in providing FastQue</h2>
            <p>
              FastQue sends information to its application backend and configured storage service to provide the product.
              Salon images and payment QR images are public-facing shop content when a salon publishes them, while access
              to account, booking and operational data is controlled by FastQue roles and endpoints.
            </p>
            <ul>
              <li>
                <strong>Google sign-in:</strong> when you choose Google sign-in, Google processes the authentication
                request and FastQue receives the verified identity information needed to sign you in.
              </li>
              <li>
                <strong>Expo notifications:</strong> when notifications are enabled, Expo&apos;s push service processes the
                device push token and notification delivery request.
              </li>
              <li>
                <strong>Resend transactional email:</strong> FastQue uses Resend to send transactional email where
                applicable, such as password-reset and staff-invitation messages.
              </li>
              <li>
                <strong>Your UPI app and salon:</strong> when you use a UPI payment option, the payment is handled by the
                UPI app and the salon&apos;s payment account. FastQue does not receive an automatic settlement confirmation.
              </li>
            </ul>
            <p>
              FastQue does not state that an optional SMS, email, object-storage or AI provider is active unless it is
              configured for the relevant service. This policy will be updated before a new external processor is enabled
              for a user-data feature.
            </p>
          </section>

          <section id="retention">
            <h2>Retention and deletion</h2>
            <p>
              FastQue retains account, booking, queue, credit and authorised
              operational records while they are needed to operate the service, maintain security and meet applicable
              record-keeping obligations. The current FastQue implementation does not use one universal automatic
              deletion schedule for all account and operational records.
            </p>
            <p>
              Salon operators can remove salon and payment-QR images through the relevant shop-management controls.
              Authenticated customer accounts can be deleted in the FastQue mobile app from Account &gt; Delete account.
              That flow removes direct account identifiers, linked sign-in methods, refresh-session records, phone-keyed OTP requests,
              customer reviews and attached owner responses, push-device registrations, notification preferences and in-app notifications.
              Booking, credit, subscription
              and security records may remain only in de-identified form where necessary for transaction integrity,
              security and applicable record-keeping obligations.
            </p>
            <p>
              If you no longer have the app, see <Link href="/account-deletion">FastQue account deletion</Link> for a
              support-assisted request path. FastQue does not publish one universal automatic deletion period.
            </p>
          </section>

          <section id="contact">
            <h2>Contact us</h2>
            <p className={styles.notice}>
              For privacy, personal-data, account or support questions, contact FastQue at{" "}
              <a href="mailto:support@fastque.com">support@fastque.com</a>.
            </p>
          </section>

          <section id="security">
            <h2>Security</h2>
            <p>
              FastQue uses HTTPS for its public web service and application API. The product uses authenticated sessions,
              role-based access controls and server-side validation for the functions described above. No system can
              guarantee absolute security, so please keep your sign-in credentials and device access secure.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              FastQue will update this policy when its data practices or relevant processors change. The current version
              is published at <Link href="/privacy-policy">fastque.com/privacy-policy</Link>.
            </p>
          </section>
        </article>
      </main>
    </CustomerShell>
  );
}
