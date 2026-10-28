import { PrismaClient, OrganizationStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEFAULT_ORG_ID = 'org_default_migration';

async function main() {
  await prisma.organization.upsert({
    where: { id: DEFAULT_ORG_ID },
    create: {
      id: DEFAULT_ORG_ID,
      name: 'Default',
      status: OrganizationStatus.ACTIVE,
    },
    update: {},
  });

  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChatControl2024!';
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@chatcontrol.local').toLowerCase();
  const hash = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      passwordHash: hash,
      displayName: 'Administrador',
      role: UserRole.ORG_ADMIN,
      organizationId: DEFAULT_ORG_ID,
    },
    update: {
      passwordHash: hash,
      organizationId: DEFAULT_ORG_ID,
      role: UserRole.ORG_ADMIN,
    },
  });

  const legacyPhone = (process.env.SEED_LEGACY_PHONE || '5491112345678').replace(/\D/g, '');
  const legacyEmail = `${legacyPhone}@legacy.chatcontrol`;
  await prisma.user.upsert({
    where: { email: legacyEmail },
    create: {
      email: legacyEmail,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      displayName: 'Legacy MVP',
      role: UserRole.AGENT,
      organizationId: DEFAULT_ORG_ID,
    },
    update: {
      organizationId: DEFAULT_ORG_ID,
    },
  });

  const superEmail = (process.env.SEED_SUPERADMIN_EMAIL || 'super@chatcontrol.local').toLowerCase();
  /** Contraseña del super admin: SEED_SUPERADMIN_PASSWORD, si no SEED_ADMIN_PASSWORD, si no la del org admin por defecto. */
  const superPassword =
    process.env.SEED_SUPERADMIN_PASSWORD?.trim() || adminPassword;
  if (process.env.SEED_SUPERADMIN === 'true') {
    const superHash = await bcrypt.hash(superPassword, 10);
    await prisma.user.upsert({
      where: { email: superEmail },
      create: {
        email: superEmail,
        passwordHash: superHash,
        displayName: 'Super admin',
        role: UserRole.SUPER_ADMIN,
        organizationId: null,
      },
      update: {
        role: UserRole.SUPER_ADMIN,
        organizationId: null,
        passwordHash: superHash,
        displayName: 'Super admin',
      },
    });
  }

  console.log('Seed OK:', { adminEmail, legacyEmail, orgId: DEFAULT_ORG_ID, superAdmin: process.env.SEED_SUPERADMIN === 'true' ? superEmail : '(omitido)' });
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
