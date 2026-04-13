import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service — Door Hardware Tracker',
}

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-foreground">
      <h1 className="text-2xl font-bold mb-6">Terms of Service</h1>
      <p className="text-sm text-muted-foreground mb-8">Last updated: April 13, 2026</p>

      <section className="space-y-6 text-sm leading-relaxed">
        <div>
          <h2 className="text-lg font-semibold mb-2">1. Acceptance of Terms</h2>
          <p>
            By accessing or using Door Hardware Tracker (&ldquo;the Service&rdquo;), operated by
            Rabbit Hole Consultants LLC (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;),
            you agree to be bound by these Terms of Service. If you do not agree, do not use the
            Service.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">2. Description of Service</h2>
          <p>
            Door Hardware Tracker is a software tool that assists construction professionals in
            extracting and organizing door hardware data from PDF specifications. The Service uses
            automated extraction and AI-assisted analysis to parse hardware schedules.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">3. Accuracy Disclaimer</h2>
          <p className="font-medium text-yellow-600 dark:text-yellow-400">
            The Service is an extraction aid, not a replacement for professional verification.
            Extracted hardware quantities, specifications, and assignments are provided as a
            reference and may contain errors. You must independently verify all extracted data
            against the original specification documents before making purchasing, installation,
            or any other decisions based on this data.
          </p>
          <p className="mt-2">
            We do not guarantee the accuracy, completeness, or reliability of any extracted data.
            The Service should not be used as the sole basis for ordering hardware, preparing
            submittals, or making installation decisions.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">4. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, Rabbit Hole Consultants LLC and its officers,
            directors, employees, and agents shall not be liable for any indirect, incidental,
            special, consequential, or punitive damages, including but not limited to loss of
            profits, data, or business opportunities, arising from your use of the Service or
            reliance on extracted data, whether based on warranty, contract, tort, or any other
            legal theory, even if we have been advised of the possibility of such damages.
          </p>
          <p className="mt-2">
            Our total aggregate liability for any claims arising from your use of the Service
            shall not exceed the amount you paid us in the twelve (12) months preceding the claim.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">5. User Responsibilities</h2>
          <p>You are responsible for:</p>
          <ul className="list-disc pl-6 mt-2 space-y-1">
            <li>Maintaining the confidentiality of your account credentials</li>
            <li>All activity that occurs under your account</li>
            <li>Ensuring you have the right to upload any documents you submit to the Service</li>
            <li>Independently verifying all extracted data before acting on it</li>
            <li>Compliance with all applicable laws and regulations</li>
          </ul>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">6. Data Handling</h2>
          <p>
            Uploaded documents and extracted data are stored on secure cloud infrastructure
            (Supabase). Access is restricted to project members as configured by project
            administrators. We use third-party AI services (Anthropic) to process document
            content during extraction. See our{' '}
            <a href="/privacy" className="underline hover:text-foreground/80">Privacy Policy</a>{' '}
            for details on how we handle your data.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">7. Account Termination</h2>
          <p>
            You may stop using the Service at any time. We may suspend or terminate your access
            if you violate these terms. Upon termination, you may request an export of your
            project data.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">8. Changes to Terms</h2>
          <p>
            We may update these Terms from time to time. We will notify you of material changes
            by posting the updated terms on this page with a new &ldquo;Last updated&rdquo; date.
            Your continued use of the Service after changes constitutes acceptance.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-2">9. Contact</h2>
          <p>
            Questions about these terms? Contact us at{' '}
            <a href="mailto:matt@rabbitholeconsultants.com" className="underline hover:text-foreground/80">
              matt@rabbitholeconsultants.com
            </a>
          </p>
        </div>
      </section>
    </main>
  )
}
