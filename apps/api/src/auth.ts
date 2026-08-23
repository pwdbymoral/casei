import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase } from "@casei/database";
import { betterAuth } from "better-auth/minimal";

export const auth = betterAuth({
  database: drizzleAdapter(createDatabase(), {
    provider: "pg",
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
});
