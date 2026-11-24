const outputLimit = 262_144
type Control = 'text' | 'escape' | 'csi' | 'string' | 'stringEnd' | 'charset'

export const terminalBytes = (data: string) => Uint8Array.from(atob(data), character => character.charCodeAt(0))
export const printable = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, '�')

export class TerminalText {
  private decoder = new TextDecoder()
  private phase: Control = 'text'
  private parameters = ''
  private carriageReturn = false
  output = ''
  interactive = false
  clipped = false

  write(data?: string) {
    const text = data === undefined ? this.decoder.decode() : this.decoder.decode(terminalBytes(data), {stream: true})
    for (const character of text) {
      if (this.phase !== 'text') {
        this.control(character)
      } else if (character === '\x1b') {
        this.phase = 'escape'
      } else if (character === '\r') {
        this.carriageReturn = true
      } else if (character === '\n' || character === '\t' || !/[\x00-\x1f\x7f-\x9f]/.test(character)) {
        if (this.carriageReturn && character !== '\n') this.output = this.output.slice(0, this.output.lastIndexOf('\n') + 1)
        this.carriageReturn = false
        this.output += character
      }
    }
    if (this.output.length > outputLimit) {
      this.clipped = true
      this.output = this.output.slice(-outputLimit)
    }
  }

  private control(character: string) {
    switch (this.phase) {
      case 'escape':
        this.phase = character === '[' ? 'csi' : ']P^_X'.includes(character) ? 'string'
          : '()*+-%#'.includes(character) ? 'charset' : 'text'
        this.parameters = ''
        break
      case 'csi':
        if (character >= '@' && character <= '~') {
          if (character === 'h' && /^\?(?:47|1047|1049)(?:;|$)/.test(this.parameters) || 'Hf'.includes(character)) {
            this.interactive = true
          }
          this.phase = 'text'
        } else if (this.parameters.length < 64) this.parameters += character
        break
      case 'string':
        if (character === '\x07') this.phase = 'text'
        else if (character === '\x1b') this.phase = 'stringEnd'
        break
      case 'stringEnd':
        this.phase = character === '\\' ? 'text' : 'string'
        break
      case 'charset':
        this.phase = 'text'
        break
    }
  }
}
