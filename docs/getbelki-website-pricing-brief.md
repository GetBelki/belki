# GetBelki.com pricing and open-source update brief

## Objective

Update the Belki website so visitors can quickly understand:

1. The differences between the Starter, Studio, and Agency managed plans.
2. That Belki can also be self-hosted in the customer's own Cloudflare account.
3. The trade-off between a managed subscription and operating the open-source software themselves.

The page should answer “Which option is right for me?” without making self-hosting look like a fourth paid tier.

## Audience

- Brands and small teams that want a simple managed service.
- Consultants and agencies that need more projects, prompts, and AI sources.
- Technical teams that prefer infrastructure ownership, data control, or customization.

## Recommended page changes

- Add **Pricing** and **Open source** links to the main navigation.
- Add a short “Choose how you run Belki” section before pricing.
- Add a three-card managed pricing comparison.
- Add a visually distinct self-hosted Cloudflare section directly below it.
- Replace generic waitlist CTAs with plan-specific CTAs when public signup is available. Until then, keep the action as **Join the waitlist** or **Request access**.
- Add **GitHub** to the header or footer once the public repository is available.

## Core positioning

### Section heading

**Choose how you run Belki**

### Intro copy

Use Belki as a fully managed service or deploy the open-source project in your own Cloudflare account. Choose convenience, or choose complete control of the infrastructure and provider credentials.

### Operating-model comparison

| | Belki Cloud | Self-hosted on Cloudflare |
|---|---|---|
| Best for | Teams that want to start quickly | Technical teams that want control and customization |
| Hosting and updates | Managed by Belki | Managed by the customer |
| Subscription | Monthly Belki plan | No Belki subscription fee |
| Infrastructure | Included and operated by Belki | Customer's Cloudflare account and usage costs |
| Data provider | Managed by Belki | Customer supplies DataForSEO credentials and pays provider costs |
| Data location | Belki-managed infrastructure | Customer's own Cloudflare account |
| Setup | Sign up and create a project | Deploy, configure secrets, and maintain the installation |

Add a short cost clarification under the table:

> Self-hosting means there is no Belki subscription fee. Cloudflare infrastructure and third-party provider usage are billed separately by those providers.

## Managed plan pricing

### Section heading

**Plans that grow with your AI visibility program**

### Supporting copy

Every managed plan includes visibility reporting, source evidence, competitor intelligence, and unlimited teammates. Choose a plan based on how many prompts, projects, and AI sources you need.

| Plan | Price | Active prompts | Projects | AI tracking sources per project | Seats | Recommended for |
|---|---:|---:|---:|---|---:|---|
| Starter | €10/month | 25 | 1 | ChatGPT | Unlimited | A single brand getting started |
| Studio | €29/month | 75 | 5 | Choose any 2 available sources | Unlimited | Growing teams and consultants |
| Agency | €149/month | 250 | 30 | All 4 available sources | Unlimited | Agencies and multi-brand teams |

Available sources: ChatGPT, Gemini, Google AI Mode, and Google AI Overviews.

Add the following definition immediately below the cards:

> One active prompt is one query Belki tracks on a schedule. If two sources are enabled for a project, Belki tracks that prompt on both sources.

Show **Most popular** on Studio. Use **Choose Starter**, **Choose Studio**, and **Choose Agency** once checkout is publicly available. Before then, use **Request access** consistently on all three cards. Add “Billed monthly; prices exclude applicable VAT or tax” near the price grid.

Do not expose internal workload units, credits, or provider-task calculations on the marketing site.

## Open-source and Cloudflare section

### Eyebrow

**Open source**

### Heading

**Run Belki in your own Cloudflare infrastructure**

### Body copy

Prefer to own the stack? Deploy the open-source Belki application to your Cloudflare account and keep control of the infrastructure, application data, and provider credentials. Belki uses Cloudflare Workers, D1, R2, Queues, Durable Objects, Cron Triggers, and Workers AI.

The self-hosted edition is available under the Apache 2.0 license. It requires a Cloudflare Workers Paid account and your own DataForSEO credentials. You are responsible for deployment, provider and infrastructure charges, monitoring, updates, and backups.

### Benefits

- Your Cloudflare account and infrastructure.
- Your DataForSEO credentials and provider relationship.
- Full access to the source code under Apache 2.0.
- Freedom to inspect, customize, and integrate the application.
- All four tracking sources enabled by the default self-hosted configuration.

### CTAs

- Primary: **Deploy to Cloudflare**
- Secondary: **View on GitHub**
- Supporting link: **Read the self-hosting guide**

Use placeholders until the repository is public. The deployment CTA should point to the repository-backed Cloudflare Deploy flow, and the guide should point to the fresh self-hosted installation instructions.

## Suggested homepage flow

1. Existing hero and product demonstration.
2. Existing feature and “How it works” sections.
3. “Choose how you run Belki” comparison.
4. Managed plan pricing cards.
5. Open-source self-hosting section.
6. Final CTA with two routes: **Request managed access** and **Deploy on Cloudflare**.

## UX and content requirements

- Make the monthly price, prompt limit, project limit, and source allowance scannable without opening a tooltip.
- Keep self-hosting visually separate from the paid cards and label it **No Belki subscription fee**, not **Free**, to avoid hiding infrastructure and provider costs.
- Use the same definitions and limits as the in-app Billing page.
- On mobile, stack Starter, Studio, and Agency in that order, followed by self-hosting.
- Avoid promising feature parity between managed and self-hosted modes unless it is explicitly maintained and tested.
- Do not publish the GitHub or Deploy links before the repository is public and the one-click deployment has been smoke-tested from a clean Cloudflare account.

## SEO updates

- Suggested title: **Belki Pricing | Managed AI Visibility or Self-Host on Cloudflare**
- Suggested meta description: **Compare Belki plans for tracking AI search visibility, or deploy the open-source platform in your own Cloudflare account.**
- Add `SoftwareApplication` offer data only when public checkout is live and prices are stable.
- Add FAQ content for “What is an active prompt?”, “Which AI sources are supported?”, “What does self-hosted cost?”, and “What do I need to deploy on Cloudflare?”

## Acceptance criteria

- All three managed plans and their differences appear on the public site.
- The four supported AI sources are named.
- Pricing clearly states monthly billing and applicable tax treatment.
- Self-hosting is presented as an alternative operating model, not a fourth SaaS tier.
- Self-hosting clearly discloses the Workers Paid and DataForSEO requirements and separate usage costs.
- GitHub, deployment, and documentation links work before publication.
- Plan values match the application configuration: €10/25/1/1, €29/75/5/2, and €149/250/30/4.
- The existing early-access language is retained or removed consistently according to launch status.
