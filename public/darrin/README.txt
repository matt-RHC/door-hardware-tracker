Darrin avatar assets for the conversational Import Wizard.

Expected files (referenced by src/components/ImportWizard/DarrinMessage.tsx):
  - darrin_scanning.png
  - darrin_excited.png
  - darrin_concerned.png
  - darrin_success.png

Replace this directory's contents with the 48x48 (or larger square) PNGs
when they're available. The DarrinMessage component requests them directly
via <Image src="/darrin/..." /> with unoptimized=true, so no build-time
import is needed — dropping the files in will be enough.
