-- Independent disabled-by-default full-booking budget. Migration issues no grant.
-- Environment root + whole-grant allocations are retained forever: new IDs,
-- stops, expiry and failed IO never restore previously approved allowance.
CREATE TABLE IF NOT EXISTS whatsapp_full_booking_budgets (
 environment TEXT PRIMARY KEY CHECK(environment IN ('staging','production')),
 budget_id TEXT NOT NULL UNIQUE, binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
 cap_micros INTEGER NOT NULL CHECK(cap_micros BETWEEN 1 AND 100000000),
 retained_micros INTEGER NOT NULL CHECK(retained_micros>=0),
 allocated_micros INTEGER NOT NULL DEFAULT 0 CHECK(allocated_micros>=0),
 held_micros INTEGER NOT NULL DEFAULT 0 CHECK(held_micros>=0 AND held_micros<=allocated_micros),
 stopped_reason TEXT, created_at INTEGER NOT NULL,
 CHECK(retained_micros+allocated_micros<=cap_micros)
);
CREATE TABLE IF NOT EXISTS whatsapp_full_booking_grants (
 id TEXT PRIMARY KEY, environment TEXT NOT NULL REFERENCES whatsapp_full_booking_budgets(environment),
 budget_id TEXT NOT NULL, binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
 root_binding TEXT NOT NULL CHECK(length(root_binding)=64), source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
 starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=86400000),
 allocation_micros INTEGER NOT NULL CHECK(allocation_micros>0),
 spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros BETWEEN 0 AND allocation_micros),
 inbound_limit INTEGER NOT NULL CHECK(inbound_limit BETWEEN 0 AND 1000), outbound_limit INTEGER NOT NULL CHECK(outbound_limit BETWEEN 0 AND 1000),
 address_limit INTEGER NOT NULL CHECK(address_limit BETWEEN 0 AND 100), model_limit INTEGER NOT NULL CHECK(model_limit BETWEEN 0 AND 100),
 inbound INTEGER NOT NULL DEFAULT 0 CHECK(inbound BETWEEN 0 AND inbound_limit), outbound INTEGER NOT NULL DEFAULT 0 CHECK(outbound BETWEEN 0 AND outbound_limit),
 address INTEGER NOT NULL DEFAULT 0 CHECK(address BETWEEN 0 AND address_limit), model INTEGER NOT NULL DEFAULT 0 CHECK(model BETWEEN 0 AND model_limit),
 stopped_reason TEXT, stopped_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_full_booking_operations (
 grant_id TEXT NOT NULL REFERENCES whatsapp_full_booking_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','address','model')), operation_key TEXT NOT NULL,
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
 status TEXT NOT NULL CHECK(status IN ('pending','settled','uncertain')),
 diagnostics_json TEXT CHECK(diagnostics_json IS NULL OR (length(diagnostics_json)<=4096 AND json_valid(diagnostics_json))),
 created_at INTEGER NOT NULL, finished_at INTEGER CHECK(finished_at IS NULL OR finished_at>=created_at),
 PRIMARY KEY(grant_id,kind,operation_key)
);
CREATE TRIGGER IF NOT EXISTS whatsapp_full_budget_no_replace BEFORE INSERT ON whatsapp_full_booking_budgets
WHEN EXISTS(SELECT 1 FROM whatsapp_full_booking_budgets WHERE environment=NEW.environment)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_no_replace BEFORE INSERT ON whatsapp_full_booking_grants
WHEN EXISTS(SELECT 1 FROM whatsapp_full_booking_grants WHERE id=NEW.id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_budget_update BEFORE UPDATE ON whatsapp_full_booking_budgets
WHEN NEW.environment!=OLD.environment OR NEW.budget_id!=OLD.budget_id OR NEW.binding_hash!=OLD.binding_hash OR NEW.cap_micros!=OLD.cap_micros
 OR NEW.retained_micros!=OLD.retained_micros OR NEW.created_at!=OLD.created_at OR NEW.allocated_micros<OLD.allocated_micros OR NEW.held_micros<OLD.held_micros
 OR (OLD.stopped_reason IS NOT NULL AND NEW.stopped_reason IS NOT OLD.stopped_reason)
BEGIN SELECT RAISE(ABORT,'full booking budget immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_budget_delete BEFORE DELETE ON whatsapp_full_booking_budgets BEGIN SELECT RAISE(ABORT,'full booking budget retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_insert BEFORE INSERT ON whatsapp_full_booking_grants
WHEN NOT EXISTS(SELECT 1 FROM whatsapp_full_booking_grants WHERE id=NEW.id) AND (
 NEW.spent_micros!=0 OR NEW.inbound!=0 OR NEW.outbound!=0 OR NEW.address!=0 OR NEW.model!=0 OR NEW.stopped_reason IS NOT NULL OR NEW.stopped_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM whatsapp_full_booking_budgets b WHERE b.environment=NEW.environment AND b.budget_id=NEW.budget_id AND b.binding_hash=NEW.root_binding
 AND b.stopped_reason IS NULL AND b.retained_micros+b.allocated_micros+NEW.allocation_micros<=b.cap_micros))
BEGIN SELECT RAISE(ABORT,'full booking grant allocation refused'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_allocate AFTER INSERT ON whatsapp_full_booking_grants
BEGIN UPDATE whatsapp_full_booking_budgets SET allocated_micros=allocated_micros+NEW.allocation_micros WHERE environment=NEW.environment; END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_update BEFORE UPDATE ON whatsapp_full_booking_grants
WHEN NEW.id!=OLD.id OR NEW.environment!=OLD.environment OR NEW.budget_id!=OLD.budget_id OR NEW.binding_hash!=OLD.binding_hash OR NEW.root_binding!=OLD.root_binding
 OR NEW.source_sha256!=OLD.source_sha256 OR NEW.starts_at!=OLD.starts_at OR NEW.expires_at!=OLD.expires_at OR NEW.allocation_micros!=OLD.allocation_micros
 OR NEW.inbound_limit!=OLD.inbound_limit OR NEW.outbound_limit!=OLD.outbound_limit OR NEW.address_limit!=OLD.address_limit OR NEW.model_limit!=OLD.model_limit
 OR NEW.created_at!=OLD.created_at OR NEW.spent_micros<OLD.spent_micros OR NEW.inbound<OLD.inbound OR NEW.outbound<OLD.outbound OR NEW.address<OLD.address OR NEW.model<OLD.model
 OR (OLD.stopped_reason IS NOT NULL AND (NEW.stopped_reason IS NOT OLD.stopped_reason OR NEW.stopped_at IS NOT OLD.stopped_at))
BEGIN SELECT RAISE(ABORT,'full booking grant immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_grant_delete BEFORE DELETE ON whatsapp_full_booking_grants BEGIN SELECT RAISE(ABORT,'full booking grant retained'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_insert BEFORE INSERT ON whatsapp_full_booking_operations
WHEN EXISTS(SELECT 1 FROM whatsapp_full_booking_operations WHERE grant_id=NEW.grant_id AND kind=NEW.kind AND operation_key=NEW.operation_key)
 OR NEW.status!='pending' OR NEW.finished_at IS NOT NULL OR NEW.diagnostics_json IS NOT NULL
 OR NEW.reserved_micros!=CASE NEW.kind WHEN 'inbound' THEN 10300 WHEN 'outbound' THEN 11300 WHEN 'address' THEN 32000 WHEN 'model' THEN 56320 END
 OR NOT EXISTS(SELECT 1 FROM whatsapp_full_booking_grants g JOIN whatsapp_full_booking_budgets b ON b.environment=g.environment WHERE g.id=NEW.grant_id
 AND g.stopped_reason IS NULL AND b.stopped_reason IS NULL AND NEW.created_at>=g.starts_at AND NEW.created_at<g.expires_at
 AND g.spent_micros+NEW.reserved_micros<=g.allocation_micros
 AND CASE NEW.kind WHEN 'inbound' THEN g.inbound<g.inbound_limit WHEN 'outbound' THEN g.outbound<g.outbound_limit WHEN 'address' THEN g.address<g.address_limit WHEN 'model' THEN g.model<g.model_limit END)
BEGIN SELECT RAISE(ABORT,'full booking operation refused'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_hold AFTER INSERT ON whatsapp_full_booking_operations
BEGIN
 UPDATE whatsapp_full_booking_grants SET spent_micros=spent_micros+NEW.reserved_micros,
 inbound=inbound+(NEW.kind='inbound'),outbound=outbound+(NEW.kind='outbound'),address=address+(NEW.kind='address'),model=model+(NEW.kind='model') WHERE id=NEW.grant_id;
 UPDATE whatsapp_full_booking_budgets SET held_micros=held_micros+NEW.reserved_micros WHERE environment=(SELECT environment FROM whatsapp_full_booking_grants WHERE id=NEW.grant_id);
END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_update BEFORE UPDATE ON whatsapp_full_booking_operations
WHEN OLD.status!='pending' OR NEW.status NOT IN ('settled','uncertain') OR NEW.finished_at IS NULL
 OR NEW.grant_id!=OLD.grant_id OR NEW.kind!=OLD.kind OR NEW.operation_key!=OLD.operation_key OR NEW.reserved_micros!=OLD.reserved_micros OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'full booking operation immutable'); END;
CREATE TRIGGER IF NOT EXISTS whatsapp_full_operation_delete BEFORE DELETE ON whatsapp_full_booking_operations BEGIN SELECT RAISE(ABORT,'full booking hold retained'); END;

-- Separate full-booking ingress authority. Payloads contain identifiers/times,
-- never message bodies. Conversation retention may cascade these transient rows.
CREATE TABLE IF NOT EXISTS whatsapp_booking_full_fences (
 conversation_id TEXT PRIMARY KEY REFERENCES whatsapp_booking_conversations(id) ON DELETE CASCADE,
 grant_id TEXT NOT NULL REFERENCES whatsapp_full_booking_grants(id), epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch>=0),
 latest_event_at INTEGER NOT NULL DEFAULT 0 CHECK(latest_event_at>=0), latest_event_key TEXT,
 stopped_at INTEGER, stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN ('operator_stop','customer_takeover','manual_takeover','ambiguous_order','model_failure','provider_failure'))
);
CREATE TRIGGER IF NOT EXISTS whatsapp_full_fence_update BEFORE UPDATE ON whatsapp_booking_full_fences
WHEN NEW.conversation_id!=OLD.conversation_id OR NEW.grant_id!=OLD.grant_id OR NEW.epoch<OLD.epoch OR NEW.latest_event_at<OLD.latest_event_at
 OR (OLD.stopped_at IS NOT NULL AND (NEW.stopped_at IS NOT OLD.stopped_at OR NEW.stop_reason IS NOT OLD.stop_reason))
BEGIN SELECT RAISE(ABORT,'full booking fence cannot rewind'); END;
CREATE TABLE IF NOT EXISTS whatsapp_booking_full_ingress (
 event_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES whatsapp_booking_conversations(id) ON DELETE CASCADE,
 event_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL CHECK(deadline_at>0 AND deadline_at<=created_at+30000)
);
CREATE TRIGGER IF NOT EXISTS whatsapp_full_ingress_update BEFORE UPDATE ON whatsapp_booking_full_ingress BEGIN SELECT RAISE(ABORT,'full booking ingress immutable'); END;
