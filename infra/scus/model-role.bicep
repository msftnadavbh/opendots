targetScope = 'resourceGroup'

@minLength(36)
@maxLength(36)
param principalId string

var authorized = subscription().subscriptionId == '68eab0d1-ab81-4851-b2dd-173dede87582' && tenant().tenantId == '16b3c013-d300-468d-ac64-7eda0820b6d3' && resourceGroup().name == 'rg-opendots-pilot'

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: 'ai-opendots-7unu3az5tgmza'
}

resource modelRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (authorized) {
  name: 'f38e4e56-1acc-5c13-9dc1-d17567962599'
  scope: foundry
  properties: {
    roleDefinitionId: '/subscriptions/68eab0d1-ab81-4851-b2dd-173dede87582/providers/Microsoft.Authorization/roleDefinitions/5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output resourceIds array = authorized ? [modelRole!.id] : []
