import MarkdownPage from './MarkdownPage'
import content from '../../../docs/AUTH_SERVICE.md?raw'

// Beginner-friendly intro content prepended to the technical docs
const beginnerIntro = `
## What is Authentication?

Authentication is how systems verify you are who you say you are. It is the digital equivalent of showing your ID at the door.

**In simple terms:** When you log in with a username and password, you are authenticating. The Auth Service is QuoxCORE's bouncer - it checks IDs, remembers who is allowed in, and keeps track of what everyone is permitted to do.

### Why Does QuoxCORE Need an Auth Service?

Without authentication, anyone could access your infrastructure through QuoxCORE. The Auth Service provides:

- **User accounts** - Everyone gets their own login, so actions can be tracked to individuals
- **Organizations** - Group users into teams or companies, each with their own private space
- **Permissions** - Control who can do what (some people can just view, others can make changes)
- **Security features** - Protect accounts with two-factor authentication and detect suspicious activity

### Key Concepts Explained

| Term | What It Means |
|------|---------------|
| **Authentication** | Proving who you are (logging in) |
| **Authorization** | Determining what you are allowed to do once logged in |
| **JWT (JSON Web Token)** | A secure "ticket" that proves you have logged in, used for each request |
| **MFA (Multi-Factor Authentication)** | Extra security where you need your password AND a code from your phone |
| **RBAC (Role-Based Access Control)** | Giving permissions based on roles like "Admin" or "Viewer" |
| **Organization** | A group of users who share resources (like a company or team) |

### How Login Works (Simplified)

1. **You enter** your email and password
2. **The Auth Service** checks if they match what is stored (passwords are encrypted, never stored in plain text)
3. **If correct**, you receive a token (like a wristband at an event)
4. **Every time** you do something in QuoxCORE, your token is checked to verify it is really you
5. **Tokens expire** after a while for security, so you may need to log in again periodically

### Understanding Roles

Different people need different levels of access. QuoxCORE uses roles to manage this:

| Role | What They Can Do |
|------|------------------|
| **Viewer** | Look at information, but cannot make changes |
| **Runner** | Execute workflows and run commands |
| **Builder** | Create new agents, workflows, and tools |
| **Admin** | Manage users, change settings, view audit logs |
| **Owner** | Full control, including deleting the organization |

### Multi-Factor Authentication (MFA)

MFA adds an extra layer of security. Even if someone steals your password, they cannot get in without your phone:

1. **Enable MFA** in your account settings
2. **Scan a QR code** with an authenticator app (like Google Authenticator or Authy)
3. **When logging in**, enter your password AND the 6-digit code from the app
4. **Backup codes** are provided in case you lose access to your phone

> **Tip for beginners:** Always enable MFA for accounts that access important systems. It takes just a few seconds during login but makes your account much harder to hack. Think of it as adding a deadbolt to your door in addition to the regular lock.

---

`;

export default function AuthServicePage() {
  return (
    <MarkdownPage
      content={beginnerIntro + content}
      title="Auth Service Documentation"
      lead="The Auth Service handles login, user accounts, and permissions. It makes sure only the right people can access QuoxCORE and controls what each person is allowed to do."
    />
  )
}
