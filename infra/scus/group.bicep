targetScope = 'subscription'

@description('Durable local migration identity; never regenerated to retry a stage.')
@minLength(36)
@maxLength(36)
param migrationId string

@description('SHA256 binding the preserved source operator inputs.')
@minLength(64)
@maxLength(64)
param sourceArchiveSha256 string

var authorized = subscription().subscriptionId == '68eab0d1-ab81-4851-b2dd-173dede87582' && tenant().tenantId == '16b3c013-d300-468d-ac64-7eda0820b6d3'

resource target 'Microsoft.Resources/resourceGroups@2024-03-01' = if (authorized) {
  name: 'rg-opendots-pilot-scus'
  location: 'southcentralus'
  tags: {
    application: 'opendots'
    environment: 'pilot'
    managedBy: 'opendots-pilot-v1'
    profileId: 'pilot-scus-v1'
    migrationId: migrationId
    sourceArchiveSha256: sourceArchiveSha256
    stage: 'group'
  }
}

output resourceIds array = authorized ? [target!.id] : []
