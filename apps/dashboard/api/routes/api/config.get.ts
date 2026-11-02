// What the page needs before anyone is signed in: which Clerk instance to sign in with.
export default defineEventHandler(() => ({ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? null }));
