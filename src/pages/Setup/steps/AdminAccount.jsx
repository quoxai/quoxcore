/**
 * Admin Account Step - Create the first admin user
 */

import { useState } from 'react'

export default function AdminAccount({ data, status, onNext, onBack }) {
    const [form, setForm] = useState({
        email: data.admin?.email || '',
        password: '',
        confirmPassword: '',
        name: data.admin?.name || '',
    })
    const [errors, setErrors] = useState({})
    const [loading, setLoading] = useState(false)
    const [serverError, setServerError] = useState(null)

    // If admin already exists, show message and allow skip
    if (status?.hasAdmin) {
        return (
            <div className="setup-step">
                <h2>Admin Account</h2>
                <div className="info-box success">
                    An admin account already exists. You can skip this step.
                </div>
                <div className="setup-actions">
                    <button className="btn btn-secondary" onClick={onBack}>
                        ← Back
                    </button>
                    <button className="btn btn-primary" onClick={() => onNext()}>
                        Continue →
                    </button>
                </div>
            </div>
        )
    }

    const validate = () => {
        const newErrors = {}

        if (!form.email) {
            newErrors.email = 'Email is required'
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
            newErrors.email = 'Invalid email format'
        }

        if (!form.password) {
            newErrors.password = 'Password is required'
        } else if (form.password.length < 12) {
            newErrors.password = 'Password must be at least 12 characters'
        }

        if (form.password !== form.confirmPassword) {
            newErrors.confirmPassword = 'Passwords do not match'
        }

        setErrors(newErrors)
        return Object.keys(newErrors).length === 0
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        setServerError(null)

        if (!validate()) return

        setLoading(true)
        try {
            const res = await fetch('/api/setup/admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: form.email,
                    password: form.password,
                    name: form.name || undefined,
                }),
            })

            const result = await res.json()

            if (!res.ok) {
                throw new Error(result.message || 'Failed to create admin account')
            }

            onNext({
                admin: {
                    email: form.email,
                    name: form.name,
                    userId: result.userId,
                    orgId: result.orgId,
                }
            })
        } catch (err) {
            setServerError(err.message)
        } finally {
            setLoading(false)
        }
    }

    const handleChange = (field) => (e) => {
        setForm({ ...form, [field]: e.target.value })
        if (errors[field]) {
            setErrors({ ...errors, [field]: null })
        }
    }

    return (
        <div className="setup-step">
            <h2>Create Admin Account</h2>
            <p>
                Set up your administrator account. This will be the primary account for managing
                QuoxCORE and can be used to invite other users.
            </p>

            <form className="setup-form" onSubmit={handleSubmit}>
                <div className={`form-group ${errors.name ? 'error' : ''}`}>
                    <label htmlFor="name">Name (optional)</label>
                    <input
                        id="name"
                        type="text"
                        value={form.name}
                        onChange={handleChange('name')}
                        placeholder="Your name"
                        autoComplete="name"
                    />
                </div>

                <div className={`form-group ${errors.email ? 'error' : ''}`}>
                    <label htmlFor="email">Email *</label>
                    <input
                        id="email"
                        type="email"
                        value={form.email}
                        onChange={handleChange('email')}
                        placeholder="admin@example.com"
                        autoComplete="email"
                        required
                    />
                    {errors.email && <span className="error-text">{errors.email}</span>}
                </div>

                <div className={`form-group ${errors.password ? 'error' : ''}`}>
                    <label htmlFor="password">Password *</label>
                    <input
                        id="password"
                        type="password"
                        value={form.password}
                        onChange={handleChange('password')}
                        placeholder="Min 12 characters"
                        autoComplete="new-password"
                        required
                    />
                    {errors.password && <span className="error-text">{errors.password}</span>}
                    <span className="hint">Use a strong password with mixed characters</span>
                </div>

                <div className={`form-group ${errors.confirmPassword ? 'error' : ''}`}>
                    <label htmlFor="confirmPassword">Confirm Password *</label>
                    <input
                        id="confirmPassword"
                        type="password"
                        value={form.confirmPassword}
                        onChange={handleChange('confirmPassword')}
                        placeholder="Repeat password"
                        autoComplete="new-password"
                        required
                    />
                    {errors.confirmPassword && <span className="error-text">{errors.confirmPassword}</span>}
                </div>

                {serverError && (
                    <div className="info-box warning">
                        {serverError}
                    </div>
                )}

                <div className="setup-actions">
                    <button type="button" className="btn btn-secondary" onClick={onBack}>
                        ← Back
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? 'Creating...' : 'Create Account →'}
                    </button>
                </div>
            </form>
        </div>
    )
}
