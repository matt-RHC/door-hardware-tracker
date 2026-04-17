import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy — Door Hardware Tracker',
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-foreground">
      <h1 className="text-2xl font-bold mb-6">Privacy Policy</h1>
      <p className="text-sm text-muted-foreground mb-8">Last updated: April 13, 2026</p>

      <section className="space-y-6 text-sm leading-relaxed">
        <div>
          <h2 className="text-lg font-semibold mb-2">1. Information We Collect</h2>

          <h3 className="font-medium mt-3 mb-1">Account Information</h3>
          <p>
            When you create an account, we collect your email address and any profile information
            you provide. Authentication is handled through Supabase Auth.
          </p>

          <h3 className="font-medium mt-3 mb-1">Uploaded Documents</h3>
          <p>
            You may upload PDF documents containing door hardware specifications. These documents
            are stored in Supabase Storage and are accessible only to members of the associated
            project.
          </p>

          <h3 className="font-medium mt-3 mb-1">Extracted Data</h3>
          <p>
            The Service extracts structured data (door numbers, hardware items, quantities,
            specifications) from your uploaded documents. This extracted data is stored in our
            database and associated with your project.
          </p>

          <h3 className="font-medium mt-3 mb-1">Usage Data</h3>
          <p>
            We collect standard usage data including extraction job logs, error logs, and feature
            usage patterns to improve the Service.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">2. How We Use Your Information</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>To provide and operate the Service</li>
            <li>To process and extract data from your uploaded documents</li>
            <li>To improve extraction accuracy and Service reliability</li>
            <li>To communicate with you about your account and the Service</li>
            <li>To detect and prevent security issues</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">3. Third-Party Services</h2>
          <p>We use the following third-party services to operate:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>
              <span className="font-medium">Supabase</span> — Database, authentication, and file
              storage. Your data is stored on Supabase&apos;s infrastructure.{' '}
              <a href="https://supabase.com/privacy" className="underline hover:text-foreground/80" target="_blank" rel="noopener noreferrer">
                Supabase Privacy Policy
              </a>
            </li>
            <li>
              <span className="font-medium">Anthropic</span> — AI-powered document analysis. Document
              content is sent to Anthropic&apos;s API for extraction and analysis during processing.
              Anthropic&apos;s API does not retain your data for training purposes.{' '}
              <a href="https://www.anthropic.com/privacy" className="underline hover:text-foreground/80" target="_blank" rel="noopener noreferrer">
                Anthropic Privacy Policy
              </a>
            </li>
            <li>
              <span className="font-medium">Vercel</span> — Application hosting and serverless
              functions.{' '}
              <a href="https://vercel.com/legal/privacy-policy" className="underline hover:text-foreground/80" target="_blank" rel="noopener noreferrer">
                Vercel Privacy Policy
              </a>
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">4. Data Retention</h2>
          <p>
            We retain your account information and project data for as long as your account is
            active. Uploaded PDFs and extracted data are retained as part of your project records.
            You may request deletion of your data at any time by contacting us.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">5. Data Security</h2>
          <p>
            We implement industry-standard security measures including:
          </p>
          <ul className="list-disc pl-6 mt-2 space-y-1">
            <li>Row Level Security (RLS) on all database tables</li>
            <li>Authenticated access to all API endpoints</li>
            <li>Internal authentication between service components</li>
            <li>Private storage buckets with signed URL access</li>
            <li>HTTPS encryption for all data in transit</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">6. Your Rights</h2>
          <p>You have the right to:</p>
          <ul className="list-disc pl-6 mt-2 space-y-1">
            <li><span className="font-medium">Access</span> — Request a copy of the data we hold about you</li>
            <li><span className="font-medium">Correction</span> — Request correction of inaccurate data</li>
            <li><span className="font-medium">Deletion</span> — Request deletion of your account and associated data</li>
            <li><span className="font-medium">Export</span> — Request a machine-readable export of your project data</li>
          </ul>
          <p className="mt-2">
            To exercise any of these rights, contact us at the email below.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">7. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will post changes on this page
            with an updated &ldquo;Last updated&rdquo; date.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">8. Contact</h2>
          <p>
            Questions about this policy? Contact us at{' '}
            <a href="mailto:matt@rabbitholeconsultants.com" className="underline hover:text-foreground/80">
              matt@rabbitholeconsultants.com
            </a>
          </p>
        </div>
      </section>
    </main>
  )
}
