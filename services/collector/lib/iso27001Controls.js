/**
 * ISO 27001:2022 Annex A — All 93 controls as structured data.
 * Single source of truth for the SoA Builder.
 */

const ISO_27001_2022_CONTROLS = [
  // A.5 Organisational Controls (37)
  { id: 'A.5.1', group: 'A.5', name: 'Policies for information security', description: 'Information security policy and topic-specific policies shall be defined, approved by management, published, communicated to and acknowledged by relevant personnel.' },
  { id: 'A.5.2', group: 'A.5', name: 'Information security roles and responsibilities', description: 'Information security roles and responsibilities shall be defined and allocated.' },
  { id: 'A.5.3', group: 'A.5', name: 'Segregation of duties', description: 'Conflicting duties and areas of responsibility shall be segregated.' },
  { id: 'A.5.4', group: 'A.5', name: 'Management responsibilities', description: 'Management shall require all personnel to apply information security in accordance with established policies.' },
  { id: 'A.5.5', group: 'A.5', name: 'Contact with authorities', description: 'The organisation shall establish and maintain contact with relevant authorities.' },
  { id: 'A.5.6', group: 'A.5', name: 'Contact with special interest groups', description: 'The organisation shall establish and maintain contact with special interest groups or specialist security forums.' },
  { id: 'A.5.7', group: 'A.5', name: 'Threat intelligence', description: 'Information relating to information security threats shall be collected and analysed to produce threat intelligence.' },
  { id: 'A.5.8', group: 'A.5', name: 'Information security in project management', description: 'Information security shall be integrated into project management throughout the project lifecycle.' },
  { id: 'A.5.9', group: 'A.5', name: 'Inventory of information and other associated assets', description: 'An inventory of information and other associated assets, including owners, shall be developed and maintained.' },
  { id: 'A.5.10', group: 'A.5', name: 'Acceptable use of information and other associated assets', description: 'Rules for the acceptable use of information and other associated assets shall be identified, documented, and implemented.' },
  { id: 'A.5.11', group: 'A.5', name: 'Return of assets', description: 'Personnel shall return all organisational assets in their possession upon change or termination of employment.' },
  { id: 'A.5.12', group: 'A.5', name: 'Classification of information', description: 'Information shall be classified according to the information security needs of the organisation.' },
  { id: 'A.5.13', group: 'A.5', name: 'Labelling of information', description: 'An appropriate set of procedures for information labelling shall be developed and implemented.' },
  { id: 'A.5.14', group: 'A.5', name: 'Information transfer', description: 'Information transfer rules, procedures, or agreements shall be in place for all types of transfer facilities.' },
  { id: 'A.5.15', group: 'A.5', name: 'Access control', description: 'Rules to control physical and logical access to information shall be established and implemented.' },
  { id: 'A.5.16', group: 'A.5', name: 'Identity management', description: 'The full lifecycle of identities shall be managed.' },
  { id: 'A.5.17', group: 'A.5', name: 'Authentication information', description: 'Allocation and management of authentication information shall be controlled.' },
  { id: 'A.5.18', group: 'A.5', name: 'Access rights', description: 'Access rights shall be provisioned, reviewed, modified, and removed in accordance with policy.' },
  { id: 'A.5.19', group: 'A.5', name: 'Information security in supplier relationships', description: 'Processes shall be defined to manage information security risks associated with suppliers.' },
  { id: 'A.5.20', group: 'A.5', name: 'Addressing information security within supplier agreements', description: 'Relevant information security requirements shall be established and agreed with each supplier.' },
  { id: 'A.5.21', group: 'A.5', name: 'Managing information security in the ICT supply chain', description: 'Processes shall be defined to manage information security risks in the ICT supply chain.' },
  { id: 'A.5.22', group: 'A.5', name: 'Monitoring, review, and change management of supplier services', description: 'The organisation shall regularly monitor, review, and manage changes in supplier services.' },
  { id: 'A.5.23', group: 'A.5', name: 'Information security for use of cloud services', description: 'Processes for acquisition, use, management, and exit from cloud services shall be established.' },
  { id: 'A.5.24', group: 'A.5', name: 'Information security incident management planning and preparation', description: 'The organisation shall plan and prepare for managing information security incidents.' },
  { id: 'A.5.25', group: 'A.5', name: 'Assessment and decision on information security events', description: 'The organisation shall assess information security events and decide if they are incidents.' },
  { id: 'A.5.26', group: 'A.5', name: 'Response to information security incidents', description: 'Information security incidents shall be responded to in accordance with documented procedures.' },
  { id: 'A.5.27', group: 'A.5', name: 'Learning from information security incidents', description: 'Knowledge gained from incidents shall be used to strengthen and improve controls.' },
  { id: 'A.5.28', group: 'A.5', name: 'Collection of evidence', description: 'Procedures for identification, collection, acquisition, and preservation of evidence shall be established.' },
  { id: 'A.5.29', group: 'A.5', name: 'Information security during disruption', description: 'The organisation shall plan how to maintain information security during disruption.' },
  { id: 'A.5.30', group: 'A.5', name: 'ICT readiness for business continuity', description: 'ICT readiness shall be planned, implemented, maintained, and tested based on business continuity objectives.' },
  { id: 'A.5.31', group: 'A.5', name: 'Legal, statutory, regulatory, and contractual requirements', description: 'Legal, statutory, regulatory, and contractual requirements shall be identified and documented.' },
  { id: 'A.5.32', group: 'A.5', name: 'Intellectual property rights', description: 'Appropriate procedures to protect intellectual property rights shall be implemented.' },
  { id: 'A.5.33', group: 'A.5', name: 'Protection of records', description: 'Records shall be protected from loss, destruction, falsification, and unauthorised access.' },
  { id: 'A.5.34', group: 'A.5', name: 'Privacy and protection of PII', description: 'Requirements regarding privacy and protection of PII shall be identified and met.' },
  { id: 'A.5.35', group: 'A.5', name: 'Independent review of information security', description: 'The approach to managing information security shall be independently reviewed at planned intervals.' },
  { id: 'A.5.36', group: 'A.5', name: 'Compliance with policies, rules, and standards', description: 'Compliance with information security policy and standards shall be regularly reviewed.' },
  { id: 'A.5.37', group: 'A.5', name: 'Documented operating procedures', description: 'Operating procedures for information processing facilities shall be documented.' },

  // A.6 People Controls (8)
  { id: 'A.6.1', group: 'A.6', name: 'Screening', description: 'Background verification checks on all candidates shall be carried out prior to joining.' },
  { id: 'A.6.2', group: 'A.6', name: 'Terms and conditions of employment', description: 'Employment agreements shall state responsibilities for information security.' },
  { id: 'A.6.3', group: 'A.6', name: 'Information security awareness, education, and training', description: 'Personnel shall receive appropriate information security awareness, education, and training.' },
  { id: 'A.6.4', group: 'A.6', name: 'Disciplinary process', description: 'A disciplinary process shall be formalised for information security policy violations.' },
  { id: 'A.6.5', group: 'A.6', name: 'Responsibilities after termination or change of employment', description: 'Information security responsibilities that remain valid after termination shall be defined.' },
  { id: 'A.6.6', group: 'A.6', name: 'Confidentiality or non-disclosure agreements', description: 'Confidentiality agreements reflecting protection needs shall be identified and signed.' },
  { id: 'A.6.7', group: 'A.6', name: 'Remote working', description: 'Security measures shall be implemented when personnel are working remotely.' },
  { id: 'A.6.8', group: 'A.6', name: 'Information security event reporting', description: 'A mechanism for personnel to report observed or suspected information security events shall be provided.' },

  // A.7 Physical Controls (14)
  { id: 'A.7.1', group: 'A.7', name: 'Physical security perimeters', description: 'Security perimeters shall be defined and used to protect areas containing information.' },
  { id: 'A.7.2', group: 'A.7', name: 'Physical entry', description: 'Secure areas shall be protected by appropriate entry controls.' },
  { id: 'A.7.3', group: 'A.7', name: 'Securing offices, rooms, and facilities', description: 'Physical security for offices and facilities shall be designed and implemented.' },
  { id: 'A.7.4', group: 'A.7', name: 'Physical security monitoring', description: 'Premises shall be continuously monitored for unauthorised physical access.' },
  { id: 'A.7.5', group: 'A.7', name: 'Protecting against physical and environmental threats', description: 'Protection against physical and environmental threats shall be designed and implemented.' },
  { id: 'A.7.6', group: 'A.7', name: 'Working in secure areas', description: 'Security measures for working in secure areas shall be designed and implemented.' },
  { id: 'A.7.7', group: 'A.7', name: 'Clear desk and clear screen', description: 'Clear desk and clear screen rules shall be defined and enforced.' },
  { id: 'A.7.8', group: 'A.7', name: 'Equipment siting and protection', description: 'Equipment shall be sited securely and protected from threats.' },
  { id: 'A.7.9', group: 'A.7', name: 'Security of assets off-premises', description: 'Off-site assets shall be protected.' },
  { id: 'A.7.10', group: 'A.7', name: 'Storage media', description: 'Storage media shall be managed through their lifecycle.' },
  { id: 'A.7.11', group: 'A.7', name: 'Supporting utilities', description: 'Information processing facilities shall be protected from power failures and utility disruptions.' },
  { id: 'A.7.12', group: 'A.7', name: 'Cabling security', description: 'Cables carrying power or data shall be protected from interception or damage.' },
  { id: 'A.7.13', group: 'A.7', name: 'Equipment maintenance', description: 'Equipment shall be maintained correctly to ensure availability and integrity.' },
  { id: 'A.7.14', group: 'A.7', name: 'Secure disposal or re-use of equipment', description: 'Equipment with storage media shall be verified to ensure sensitive data has been removed prior to disposal.' },

  // A.8 Technological Controls (34)
  { id: 'A.8.1', group: 'A.8', name: 'User endpoint devices', description: 'Information stored on or accessible via user endpoint devices shall be protected.' },
  { id: 'A.8.2', group: 'A.8', name: 'Privileged access rights', description: 'The allocation and use of privileged access rights shall be restricted and managed.' },
  { id: 'A.8.3', group: 'A.8', name: 'Information access restriction', description: 'Access to information shall be restricted in accordance with access control policy.' },
  { id: 'A.8.4', group: 'A.8', name: 'Access to source code', description: 'Read and write access to source code, development tools, and software libraries shall be managed.' },
  { id: 'A.8.5', group: 'A.8', name: 'Secure authentication', description: 'Secure authentication technologies and procedures shall be implemented.' },
  { id: 'A.8.6', group: 'A.8', name: 'Capacity management', description: 'The use of resources shall be monitored and adjusted in line with capacity requirements.' },
  { id: 'A.8.7', group: 'A.8', name: 'Protection against malware', description: 'Protection against malware shall be implemented with appropriate user awareness.' },
  { id: 'A.8.8', group: 'A.8', name: 'Management of technical vulnerabilities', description: 'Information about technical vulnerabilities shall be obtained and appropriate measures taken.' },
  { id: 'A.8.9', group: 'A.8', name: 'Configuration management', description: 'Configurations including security configurations shall be established, documented, and reviewed.' },
  { id: 'A.8.10', group: 'A.8', name: 'Information deletion', description: 'Information stored in systems or media shall be deleted when no longer required.' },
  { id: 'A.8.11', group: 'A.8', name: 'Data masking', description: 'Data masking shall be used in accordance with access control and related policies.' },
  { id: 'A.8.12', group: 'A.8', name: 'Data leakage prevention', description: 'Data leakage prevention measures shall be applied to systems processing sensitive information.' },
  { id: 'A.8.13', group: 'A.8', name: 'Information backup', description: 'Backup copies of information, software, and systems shall be maintained and tested.' },
  { id: 'A.8.14', group: 'A.8', name: 'Redundancy of information processing facilities', description: 'Information processing facilities shall be implemented with sufficient redundancy.' },
  { id: 'A.8.15', group: 'A.8', name: 'Logging', description: 'Logs that record activities, exceptions, faults, and events shall be produced, stored, protected, and analysed.' },
  { id: 'A.8.16', group: 'A.8', name: 'Monitoring activities', description: 'Networks, systems, and applications shall be monitored for anomalous behaviour.' },
  { id: 'A.8.17', group: 'A.8', name: 'Clock synchronisation', description: 'Clocks of information processing systems shall be synchronised to approved time sources.' },
  { id: 'A.8.18', group: 'A.8', name: 'Use of privileged utility programs', description: 'The use of utility programs capable of overriding controls shall be restricted.' },
  { id: 'A.8.19', group: 'A.8', name: 'Installation of software on operational systems', description: 'Procedures shall be implemented to securely manage software installation on operational systems.' },
  { id: 'A.8.20', group: 'A.8', name: 'Networks security', description: 'Networks and network devices shall be secured, managed, and controlled.' },
  { id: 'A.8.21', group: 'A.8', name: 'Security of network services', description: 'Security mechanisms and service levels of network services shall be identified and monitored.' },
  { id: 'A.8.22', group: 'A.8', name: 'Segregation of networks', description: 'Groups of information services, users, and systems shall be segregated in networks.' },
  { id: 'A.8.23', group: 'A.8', name: 'Web filtering', description: 'Access to external websites shall be managed to reduce exposure to malicious content.' },
  { id: 'A.8.24', group: 'A.8', name: 'Use of cryptography', description: 'Rules for the effective use of cryptography including key management shall be defined.' },
  { id: 'A.8.25', group: 'A.8', name: 'Secure development life cycle', description: 'Rules for the secure development of software and systems shall be established.' },
  { id: 'A.8.26', group: 'A.8', name: 'Application security requirements', description: 'Information security requirements shall be identified when developing or acquiring applications.' },
  { id: 'A.8.27', group: 'A.8', name: 'Secure system architecture and engineering principles', description: 'Principles for engineering secure systems shall be established and applied.' },
  { id: 'A.8.28', group: 'A.8', name: 'Secure coding', description: 'Secure coding principles shall be applied to software development.' },
  { id: 'A.8.29', group: 'A.8', name: 'Security testing in development and acceptance', description: 'Security testing processes shall be defined and implemented in the development lifecycle.' },
  { id: 'A.8.30', group: 'A.8', name: 'Outsourced development', description: 'Activities related to outsourced system development shall be directed, monitored, and reviewed.' },
  { id: 'A.8.31', group: 'A.8', name: 'Separation of development, test, and production environments', description: 'Development, testing, and production environments shall be separated and secured.' },
  { id: 'A.8.32', group: 'A.8', name: 'Change management', description: 'Changes to information processing facilities and systems shall be subject to change management.' },
  { id: 'A.8.33', group: 'A.8', name: 'Test information', description: 'Test information shall be appropriately selected, protected, and managed.' },
  { id: 'A.8.34', group: 'A.8', name: 'Protection of information systems during audit testing', description: 'Audit tests involving operational systems shall be planned and agreed to minimise disruptions.' },
]

const GROUP_NAMES = {
  'A.5': 'Organisational Controls',
  'A.6': 'People Controls',
  'A.7': 'Physical Controls',
  'A.8': 'Technological Controls',
}

const GROUPS = ['A.5', 'A.6', 'A.7', 'A.8']

function getControlsByGroup(group) {
  return ISO_27001_2022_CONTROLS.filter(c => c.group === group)
}

function getControl(controlId) {
  return ISO_27001_2022_CONTROLS.find(c => c.id === controlId) || null
}

function getAllControls() {
  return ISO_27001_2022_CONTROLS
}

function getGroupCounts() {
  return GROUPS.map(g => ({
    group: g,
    name: GROUP_NAMES[g],
    count: ISO_27001_2022_CONTROLS.filter(c => c.group === g).length,
  }))
}

module.exports = {
  ISO_27001_2022_CONTROLS,
  GROUP_NAMES,
  GROUPS,
  getControlsByGroup,
  getControl,
  getAllControls,
  getGroupCounts,
}
