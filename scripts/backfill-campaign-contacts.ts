import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Backfill: Asignar campaña activa a todos los contactos ===\n');

  const activeCampaigns = await prisma.campaign.findMany({
    where: { isActive: true },
    include: { organization: { select: { id: true, name: true } } },
  });

  if (activeCampaigns.length === 0) {
    console.log('No hay campañas activas. Nada que backfillear.');
    await prisma.$disconnect();
    return;
  }

  let totalContacts = 0;
  let totalConversations = 0;
  let totalCampaignContacts = 0;

  for (const campaign of activeCampaigns) {
    const orgName = campaign.organization.name;
    console.log(`\n📌 Organización: ${orgName} | Campaña activa: ${campaign.name} (${campaign.id})`);

    const contacts = await prisma.contact.findMany({
      where: { organizationId: campaign.organizationId },
      select: { id: true, phone: true, campaignId: true },
    });

    console.log(`   Contactos encontrados: ${contacts.length}`);

    let orgContacts = 0;
    let orgConversations = 0;
    let orgCampaignContacts = 0;

    for (const contact of contacts) {
      if (contact.campaignId !== campaign.id) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { campaignId: campaign.id },
        });
        orgContacts++;
      }

      const conversations = await prisma.conversation.findMany({
        where: { contactId: contact.id },
        select: { id: true, campaignId: true },
      });

      for (const conv of conversations) {
        if (conv.campaignId !== campaign.id) {
          await prisma.conversation.update({
            where: { id: conv.id },
            data: { campaignId: campaign.id },
          });
          orgConversations++;
        }
      }

      await prisma.campaignContact.upsert({
        where: {
          campaignId_contactId: {
            campaignId: campaign.id,
            contactId: contact.id,
          },
        },
        create: {
          campaignId: campaign.id,
          contactId: contact.id,
        },
        update: {},
      });
      orgCampaignContacts++;
    }

    console.log(`   ✅ Contactos actualizados: ${orgContacts}`);
    console.log(`   ✅ Conversaciones actualizadas: ${orgConversations}`);
    console.log(`   ✅ CampaignContact asegurados: ${orgCampaignContacts}`);

    totalContacts += orgContacts;
    totalConversations += orgConversations;
    totalCampaignContacts += orgCampaignContacts;
  }

  console.log('\n========================================');
  console.log('   BACKFILL COMPLETADO');
  console.log('========================================');
  console.log(`   Total contactos actualizados: ${totalContacts}`);
  console.log(`   Total conversaciones actualizadas: ${totalConversations}`);
  console.log(`   Total CampaignContact asegurados: ${totalCampaignContacts}`);
  console.log('========================================\n');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Error durante backfill:', e);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
