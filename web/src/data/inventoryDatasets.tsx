import {DatabaseIcon, GlobeIcon, ShieldIcon, type Icon} from '@primer/octicons-react'
import type {DataObject, Snapshot} from '../api/telemetry'
import type {Message} from '../i18n'
import {fieldLabel} from './dataFields'
import {object, records, textValue} from './format'
import {cell, fieldColumns, objectDataset, valueCell, type ReadingDataset} from './readingModel'
import {historyDataset, type ReadingContext} from './telemetryDatasets'

interface InventoryOptions {
  key: string
  title: Message
  fields: string[]
  items: DataObject[]
  icon: Icon
  snapshot?: Snapshot
  present?: boolean
  nameField?: string
  idFields: string[]
}

function inventory({key, title, fields, items, icon: Icon, snapshot, present = Boolean(snapshot), nameField = 'name', idFields}: InventoryOptions,
  {locale, t}: ReadingContext): ReadingDataset {
  return {
    key, title: t(title), nameTitle: fieldLabel(nameField, locale), columns: fieldColumns(fields, locale),
    rows: items.map(item => ({
      id: JSON.stringify(idFields.map(field => item[field])),
      name: cell(textValue(item[nameField]) ?? textValue(item.id) ?? t('missing')), icon: <Icon />, value: item,
      values: Object.fromEntries(fields.map(field => [field, valueCell(field, item[field], locale, t, ['state', 'status'].includes(field))])),
    })),
    snapshot, icons: true, details: true, empty: t(present ? 'dataEmptyList' : 'dataNoSample'),
  }
}

export function networkDatasets(context: ReadingContext) {
  const {telemetry, locale, t} = context
  const sample = telemetry.samples.network
  const {interfaces, ...settings} = object(sample?.value) ?? {}
  const connection = Object.fromEntries(Object.entries(telemetry.connection)) as DataObject
  const list = inventory({key: 'interfaces', title: 'dataInterfaces', fields: ['address', 'family', 'up', 'loopback'],
    items: records(interfaces), icon: GlobeIcon, snapshot: sample, idFields: ['name', 'address', 'family']}, context)
  return [list,
    objectDataset('connection', t('dataConnection'), connection, locale, t,
      {observedAt: telemetry.connection.lastCommunicationAt ?? null, stale: !telemetry.connection.online}),
    objectDataset('network', t('dataNetwork'), settings, locale, t, sample),
    historyDataset('connection.quality', context),
  ]
}

export function storageDatasets(context: ReadingContext) {
  const {disk, storage} = context.telemetry.samples
  return [
    inventory({key: 'volumes', title: 'dataVolumes', fields: ['type', 'usedBytes', 'availableBytes', 'totalBytes'],
      items: records(disk?.value), icon: DatabaseIcon, snapshot: disk, nameField: 'mountPath', idFields: ['mountPath']}, context),
    inventory({key: 'external', title: 'dataExternal', fields: ['fileSystem', 'mountPath', 'remainingBytes', 'capacityBytes', 'transport', 'status'],
      items: records(storage?.value), icon: DatabaseIcon, snapshot: storage, idFields: ['id']}, context),
    historyDataset('disk', context),
  ]
}

export function permissionDatasets(context: ReadingContext, grants: DataObject[] | undefined, pending: boolean) {
  const {telemetry, locale} = context
  const {permissions, roots} = telemetry.samples
  const states = Object.entries(object(permissions?.value) ?? {}).map(([key, state]) =>
    ({...object(state), key, name: fieldLabel(key, locale)}))
  return [
    inventory({key: 'permissions', title: 'dataPermissionState', fields: ['state', 'phase', 'checkedAt', 'writable'],
      items: states, icon: ShieldIcon, snapshot: permissions, idFields: ['key']}, context),
    inventory({key: 'local', title: 'dataLocalRoots', fields: ['primary', 'writable', 'rootKey'],
      items: records(roots?.value), icon: ShieldIcon, snapshot: roots, nameField: 'label', idFields: ['rootKey']}, context),
    {...inventory({key: 'grants', title: 'dataServerRoots', fields: ['enabled', 'writable', 'rootKey', 'revision'],
      items: grants ?? [], icon: ShieldIcon, present: Boolean(grants), nameField: 'label', idFields: ['id']}, context), pending},
  ]
}
