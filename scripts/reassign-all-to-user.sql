-- =====================================================
-- REASIGNAR TODAS LAS CONVERSACIONES A UN SOLO USUARIO
-- =====================================================
-- Antes de ejecutar, reemplaza:
--   'email@ejemplo.com' → email del usuario destino
--   true                → false si solo quieres chats no asignados
-- =====================================================

DO $$
DECLARE
  v_user_id    TEXT;
  v_org_id     TEXT;
  v_total      INT;
  v_updated    INT;
BEGIN
  -- 1. Buscar usuario por email
  SELECT id, "organizationId" INTO v_user_id, v_org_id
  FROM "User"
  WHERE email = 'email@ejemplo.com';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no encontrado';
  END IF;

  RAISE NOTICE 'Usuario: % | Organización: %', v_user_id, v_org_id;

  -- 2. Contar conversaciones a actualizar
  --    Cambiar true → false para solo las no asignadas
  SELECT COUNT(*) INTO v_total
  FROM "Conversation" c
  JOIN "Contact" ct ON ct.id = c."contactId"
  WHERE ct."organizationId" = v_org_id
    AND (true OR c."assignedToUserId" IS NULL);

  RAISE NOTICE 'Conversaciones a reasignar: %', v_total;

  -- 3. Ejecutar la actualización
  UPDATE "Conversation" c
  SET "assignedToUserId" = v_user_id,
      "assignedAt" = NOW()
  FROM "Contact" ct
  WHERE ct.id = c."contactId"
    AND ct."organizationId" = v_org_id
    AND (true OR c."assignedToUserId" IS NULL);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE '✅ % conversaciones asignadas a %', v_updated, 'email@ejemplo.com';

  -- 4. Mostrar las que quedaron asignadas a otros
  SELECT COUNT(*) INTO v_total
  FROM "Conversation" c
  JOIN "Contact" ct ON ct.id = c."contactId"
  WHERE ct."organizationId" = v_org_id
    AND c."assignedToUserId" IS NOT NULL
    AND c."assignedToUserId" != v_user_id;

  IF v_total > 0 THEN
    RAISE NOTICE '⚠️  % conversaciones siguen asignadas a OTROS usuarios', v_total;
  END IF;
END $$;
