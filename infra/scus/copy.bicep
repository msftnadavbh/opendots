targetScope = 'resourceGroup'

@description('Durable migration identity from the private version-3 journal.')
@minLength(36)
@maxLength(36)
param migrationId string

@description('SHA256 binding the preserved source operator inputs.')
@minLength(64)
@maxLength(64)
param sourceArchiveSha256 string

@description('Pinned source OS snapshot unique ID; never a resource-name-only lineage assertion.')
param osSourceUniqueId string

@description('Pinned source data snapshot unique ID; never a resource-name-only lineage assertion.')
param dataSourceUniqueId string

var authorized = subscription().subscriptionId == '68eab0d1-ab81-4851-b2dd-173dede87582' && tenant().tenantId == '16b3c013-d300-468d-ac64-7eda0820b6d3' && resourceGroup().name == 'rg-opendots-pilot-scus'
var tags = {
  application: 'opendots'
  environment: 'pilot'
  managedBy: 'opendots-pilot-v1'
  profileId: 'pilot-scus-v1'
  migrationId: migrationId
  sourceArchiveSha256: sourceArchiveSha256
  stage: 'copy'
}

resource os 'Microsoft.Compute/snapshots@2025-01-02' = if (authorized) {
  name: 'snap-opendots-scus-os-v1'
  location: 'southcentralus'
  tags: union(tags, { expectedSourceUniqueId: osSourceUniqueId })
  sku: { name: 'Standard_LRS' }
  properties: {
    creationData: {
      createOption: 'CopyStart'
      sourceResourceId: '/subscriptions/68eab0d1-ab81-4851-b2dd-173dede87582/resourceGroups/rg-opendots-pilot-scus/providers/Microsoft.Compute/snapshots/snap-opendots-source-os-v1'
    }
    incremental: true
    diskSizeGB: 30
    osType: 'Linux'
    hyperVGeneration: 'V2'
    securityProfile: { securityType: 'TrustedLaunch' }
    encryption: { type: 'EncryptionAtRestWithPlatformKey' }
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}

resource data 'Microsoft.Compute/snapshots@2025-01-02' = if (authorized) {
  name: 'snap-opendots-scus-data-v1'
  location: 'southcentralus'
  tags: union(tags, { expectedSourceUniqueId: dataSourceUniqueId })
  sku: { name: 'Standard_LRS' }
  properties: {
    creationData: {
      createOption: 'CopyStart'
      sourceResourceId: '/subscriptions/68eab0d1-ab81-4851-b2dd-173dede87582/resourceGroups/rg-opendots-pilot-scus/providers/Microsoft.Compute/snapshots/snap-opendots-source-data-v1'
    }
    incremental: true
    diskSizeGB: 32
    encryption: { type: 'EncryptionAtRestWithPlatformKey' }
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}

output resourceIds array = authorized ? [os!.id, data!.id] : []
