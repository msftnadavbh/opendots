targetScope = 'subscription'

@description('Dedicated Ed25519 public key; never supply a private key.')
@minLength(80)
@maxLength(256)
param sshPublicKey string

@description('Historical operator IPv4 /32 pin; retained for state compatibility, not an SSH firewall allowance.')
@minLength(10)
@maxLength(18)
param operatorIpv4Cidr string

// This template is intentionally not a configurable production deployment.
var authorized = subscription().subscriptionId == '68eab0d1-ab81-4851-b2dd-173dede87582' && tenant().tenantId == '16b3c013-d300-468d-ac64-7eda0820b6d3' && endsWith(operatorIpv4Cidr, '/32') && startsWith(sshPublicKey, 'ssh-ed25519 ')
var tags = {
  application: 'opendots'
  environment: 'pilot'
  managedBy: 'opendots-pilot-v1'
}

resource pilotGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = if (authorized) {
  name: 'rg-opendots-pilot'
  location: 'eastus2'
  tags: tags
}

module pilot './pilot.bicep' = if (authorized) {
  name: 'opendots-pilot-resources'
  // Explicit scope avoids losing the RG scope through a nullable resource reference.
  scope: resourceGroup('rg-opendots-pilot')
  dependsOn: [
    pilotGroup
  ]
  params: {
    tags: tags
    sshPublicKey: sshPublicKey
    operatorIpv4Cidr: operatorIpv4Cidr
  }
}

// No model keys, registry passwords, or owner credentials belong in deployment history.
output pilot object = authorized ? pilot!.outputs.pilot : {}
