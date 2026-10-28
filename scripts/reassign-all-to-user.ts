import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  const orgIdentifier = process.argv[3];
  const force = process.argv[4] === 'force';

  if (!email || !orgIdentifier) {
    console.log('Uso: npx ts-node scripts/reassign-all-to-user.ts <email> <organizationId|orgName> [force]');
    console.log('');
    console.log('Ejemplos:');
    console.log('  npx ts-node scripts/reassign-all-to-user.ts agente@email.com cmqivxqtc0007bhighodtsjre');
    console.log('  npx ts-node scripts/reassign-all-to-user.ts agente@email.com "Krake"');
    console.log('  npx ts-node scripts/reassign-all-to-user.ts agente@email.com "Krake" force');
    process.exit(1);
  }

  // 1. Buscar el usuario por email
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Usuario con email "${email}" no encontrado`);
    process.exit(1);
  }
  console.log(`Usuario: ${user.displayName || user.email} (${user.id})`);

  // 2. Buscar la organización por ID o nombre
  let org = await prisma.organization.findUnique({ where: { id: orgIdentifier } });
  if (!org) {
    org = await prisma.organization.findFirst({ where: { name: orgIdentifier } });
  }
  if (!org) {
    console.error(`Organización "${orgIdentifier}" no encontrada`);
    process.exit(1);
  }
  console.log(`Organización: ${org.name} (${org.id})`);

  // 3. Revisar si el usuario pertenece a la organización
  if (user.organizationId !== org.id) {
    console.error(`El usuario ${email} no pertenece a la organización ${org.name}`);
    process.exit(1);
  }

  // 4. Contar conversaciones (sin asignar o todas)
  const whereBase: any = { contact: { organizationId: org.id } };

  if (force) {
    whereBase.assignedToUserId = { not: user.id };
  } else {
    whereBase.assignedToUserId = null;
  }

  const totalToAssign = await prisma.conversation.count({ where: whereBase });
  console.log(`\nConversaciones a reasignar: ${totalToAssign}${force ? ' (incluye ya asignadas a otros)' : ''}`);

  if (totalToAssign === 0) {
    console.log('No hay conversaciones para reasignar.');
    await prisma.$disconnect();
    return;
  }

  // 5. Reasignar
  console.log(`Asignando todas a ${email}...`);
  const result = await prisma.conversation.updateMany({
    where: whereBase,
    data: {
      assignedToUserId: user.id,
      assignedAt: new Date(),
    },
  });

  console.log(`✅ ${result.count} conversaciones asignadas a ${email}`);

  // 6. Si hay conversaciones asignadas a este usuario que NO se tocaron
  if (!force) {
    const stillAssigned = await prisma.conversation.count({
      where: {
        contact: { organizationId: org.id },
        assignedToUserId: { not: user.id },
      },
    });
    if (stillAssigned > 0) {
      console.log(`\n⚠️  ${stillAssigned} conversaciones siguen asignadas a OTROS usuarios.`);
      console.log('Para reasignarlas también:');
      console.log(`  npx ts-node scripts/reassign-all-to-user.ts "${email}" "${org.id}" force`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Error:', e);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
