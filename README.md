# Door Hardware Tracker

Real-time door hardware installation tracking for construction projects. Upload submittal PDFs, generate QR codes for each door, and track hardware installation progress from the field.

## Features

- **PDF Submittal Upload**: Upload door hardware submittal PDFs and automatically parse opening specifications
- **QR Code Generation**: Generate unique QR codes for each door opening for field tracking
- **Real-time Progress Tracking**: Track hardware installation status in real-time from the field
- **Project Management**: Organize projects by job number, general contractor, architect, and address
- **Hardware Set Tracking**: Manage multiple hardware sets and configurations per project
- **Installation Checklists**: Maintain detailed checklists for each door opening with hardware installation status
- **Field-Friendly Interface**: Mobile-optimized QR code scanner and progress updates
- **Collaborative Workflows**: Support for multiple team members tracking progress simultaneously

## Tech Stack

- **Frontend**: Next.js 14+, React, TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes
- **Database**: Supabase (PostgreSQL)
- **Real-time**: Supabase Realtime subscriptions
- **QR Codes**: QR code generation and scanning
- **Deployment**: Vercel

## Screenshots

[Screenshots section - to be added]

## Getting Started

### Prerequisites
- Node.js 18+ and npm
- Supabase account (free tier available at https://supabase.com)
- Git

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/door-hardware-tracker.git
   cd door-hardware-tracker
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up Supabase project**
   - Create a new project at https://supabase.com
   - Run the migration SQL file:
     - In the Supabase dashboard, go to SQL Editor
     - Create a new query and run the schema migration (see `supabase/migrations/` directory)
   - Enable Realtime on the `checklist_progress` table:
     - Go to Database → Replication
     - Toggle "Realtime" on for the `checklist_progress` table

4. **Configure environment variables**
   ```bash
   cp .env.example .env.local
   ```
   Fill in your Supabase credentials in `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   ```

5. **Start the development server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous (public) API key | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (for server-side operations) | Yes |

## Supabase Setup

### Running the Migration

1. Open the Supabase SQL Editor
2. Create a new query
3. Copy and run the schema migration SQL file from `supabase/migrations/`
4. The migration will create the following tables:
   - `projects`: Project metadata (name, job number, contractor, architect, address)
   - `openings`: Door openings with hardware specifications
   - `checklist_progress`: Real-time installation progress tracking

### Enabling Real-time Subscriptions

1. Navigate to Database → Replication in the Supabase dashboard
2. Find the `checklist_progress` table
3. Toggle the Realtime switch to enable real-time updates

### Row Level Security (RLS)

Enable RLS policies to restrict access:

1. For `checklist_progress` table:
   - Add policy: Allow users to select/insert/update their own project entries
   - Scope policies by project_id or authentication user

### Storage Bucket Setup

1. Create a new storage bucket for PDF uploads:
   - Navigate to Storage in Supabase dashboard
   - Create a new bucket named `submittal-pdfs`
   - Set it to private (restrict public access)
2. Create another bucket for QR codes:
   - Create bucket named `qr-codes`
   - Set appropriate access policies

## Seed Data

The `supabase/seed.sql` file contains sample data for the Radius DC Project Smash project including:
- **Project**: Radius DC Project Smash (Job #306169)
- **Contractor**: DPR Construction
- **Architect**: Highland Associates
- **Location**: 2902 Brick Church Pike, Nashville, TN 37207
- **Openings**: 104 door openings with hardware specifications

To load seed data:
```bash
npm run seed
```
(Requires appropriate database permissions)

## Architecture Overview

```
door-hardware-tracker/
├── app/                          # Next.js app directory
│   ├── api/                      # API routes
│   ├── projects/                 # Project management pages
│   ├── openings/                 # Door opening management
│   └── layout.tsx
├── components/                   # Reusable React components
│   ├── QRScanner.tsx
│   ├── ProgressTracker.tsx
│   └── ProjectForm.tsx
├── lib/
│   ├── supabase.ts              # Supabase client
│   └── utils.ts
├── supabase/
│   ├── migrations/              # Database migrations
│   └── seed.sql                 # Seed data
├── public/                       # Static assets
├── .env.example                 # Environment variable template
├── package.json
├── tailwind.config.ts
└── README.md
```

## Deployment to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyourusername%2Fdoor-hardware-tracker&env=NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY)

### Manual Deployment

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com) and sign in with your GitHub account
3. Click "Add New..." → "Project"
4. Import your repository
5. Set environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
6. Click "Deploy"

## Vercel build controls

Preview builds are gated by `scripts/vercel-ignore-build.sh`, configured in
Vercel → Project Settings → Git → "Ignored Build Step" as:

    bash scripts/vercel-ignore-build.sh

The script skips builds when:
- The PR is marked as draft (requires `GITHUB_TOKEN` project env var).
- The commit only touches `docs/`, `tests/`, `prompts/`, `scripts/`,
  `.github/`, top-level `*.md`, or other build-irrelevant paths.

Production builds on `main` always proceed. See the script header for the
full rule list.

## Development

### Build
```bash
npm run build
```

### Run tests
```bash
npm run test
```

### Format code
```bash
npm run format
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details
