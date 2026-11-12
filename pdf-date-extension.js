'use strict'

// The Antora Assembler always sets the PDF title page's `revdate` attribute to
// the build date in ISO format (YYYY-MM-DD), and Asciidoctor PDF renders that
// value verbatim. The EJPD/Word title pages use the Swiss date format instead
// (DD.MM.YYYY).
//
// The Assembler builds each assembly from the document attributes, which take
// precedence over its own ISO default, but neither the Assembler profile nor
// the PDF theme can reformat a date. This extension therefore rewrites the
// playbook's global `revdate` attribute during `playbookBuilt`, before Antora
// resolves the AsciiDoc configuration and the Assembler creates the assemblies.
module.exports.register = function () {
  this.on('playbookBuilt', ({ playbook }) => {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    const revdate = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`
    const attributes = ((playbook.asciidoc ??= {}).attributes ??= {})
    attributes.revdate = revdate
  })
}
