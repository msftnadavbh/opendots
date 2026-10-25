targetScope = 'resourceGroup'

param tags object
param sshPublicKey string
param operatorIpv4Cidr string

var location = 'eastus2'
var suffix = uniqueString(resourceGroup().id)
var principalId = 'ad4d1fc5-ea1f-4e76-a56c-934f5b1b52e9'
var sandboxRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'c24cf47c-5077-412d-a19c-45202126392c')

// Stable ARM schema: do not copy identity/defaults from preview examples.
resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-07-01' = {
  name: 'sbx-opendots-pilot'
  location: location
  tags: tags
  // The service preflight requires this even though the schema marks it optional.
  properties: {}
}

resource sandboxOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroup.id, principalId, sandboxRole)
  scope: sandboxGroup
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: sandboxRole
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'odpilot${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    dataEndpointEnabled: false
    networkRuleBypassAllowedForTasks: false
    roleAssignmentMode: 'LegacyRegistryPermissions'
  }
}

resource pullScope 'Microsoft.ContainerRegistry/registries/scopeMaps@2025-11-01' = {
  parent: registry
  name: 'opendots-pilot-pull'
  properties: {
    description: 'opendots-pilot-v1: temporary image import, read-only opendots repository'
    actions: [
      'repositories/opendots/content/read'
      'repositories/opendots/metadata/read'
    ]
  }
}

resource importToken 'Microsoft.ContainerRegistry/registries/tokens@2025-11-01' = {
  parent: registry
  name: 'opendots-pilot-import'
  properties: {
    scopeMapId: pullScope.id
    status: 'disabled'
    // Deliberately no credentials. The operator generates only expiring password1.
  }
}

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'ai-opendots-${suffix}'
  location: location
  tags: tags
  kind: 'AIServices'
  // Project management requires the parent account's own identity; it gets no extra roles.
  identity: { type: 'SystemAssigned' }
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: 'ai-opendots-${suffix}'
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundry
  name: 'opendots'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  // Foundry serializes child writes on the account; avoid project/model conflicts.
  dependsOn: [
    chat
  ]
  properties: {
    displayName: 'OpenDots pilot'
    description: 'Node orchestration with CopilotKit Intelligence history'
  }
}

resource chat 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: 'dot-chat'
  sku: {
    name: 'GlobalStandard'
    capacity: 50
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4-mini'
      version: '2026-03-17'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
    // Preserve the observed service-default content filter on redeployment.
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: 'log-opendots-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.1')
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-opendots-${suffix}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    RetentionInDays: 30
    IngestionMode: 'LogAnalytics'
  }
}

module vm './vm.bicep' = {
  name: 'opendots-pilot-vm'
  params: {
    tags: tags
    sshPublicKey: sshPublicKey
    operatorIpv4Cidr: operatorIpv4Cidr
  }
}

var modelRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
resource vmModelUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, resourceId('Microsoft.Compute/virtualMachines', 'vm-opendots-pilot'), modelRole)
  scope: foundry
  properties: {
    principalId: vm.outputs.vmPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: modelRole
  }
}

output pilot object = {
  tenantId: tenant().tenantId
  subscriptionId: subscription().subscriptionId
  resourceGroup: resourceGroup().name
  location: location
  sandboxGroupName: sandboxGroup.name
  sandboxGroupId: sandboxGroup.id
  dataPlaneEndpoint: 'https://management.eastus2.azuredevcompute.io'
  registryName: registry.name
  registryId: registry.id
  registryLoginServer: registry.properties.loginServer
  scopeMapName: pullScope.name
  tokenName: importToken.name
  foundryName: foundry.name
  foundryId: foundry.id
  foundryPrincipalId: foundry.identity.principalId
  projectId: project.id
  projectPrincipalId: project.identity.principalId
  projectEndpoint: 'https://${foundry.name}.services.ai.azure.com/api/projects/${project.name}'
  modelDeployment: chat.name
  modelEndpoint: 'https://${foundry.name}.openai.azure.com/openai/v1'
  logAnalyticsId: logs.id
  applicationInsightsId: insights.id
  applicationInsightsConnectionString: insights.properties.ConnectionString
  modelAuthMode: 'managed-identity'
  modelRoleAssignmentId: vmModelUser.id
  vm: vm.outputs.vm
}
